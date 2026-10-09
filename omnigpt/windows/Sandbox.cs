// OmniGPT.Sandbox: runs one piece of code (Python or JavaScript) inside a Windows AppContainer.
// An AppContainer process has no network access and no access to the user's files unless a folder is explicitly granted;
// a Job Object adds a memory cap and kills the whole process tree on timeout. Written for the C# 5 compiler in Windows.
//   usage:  OmniGPT.Sandbox.exe <installRoot> <python|javascript> <timeoutSeconds> <memoryMB> [--in <folder>] [--out <folder>]
//           (code is read from stdin). --in: the files in that folder are copied into the run's "input" folder first.
//           --out: after the run, the files the code wrote to its "output" folder are copied there (links are never followed).
//   prints one JSON object: {"stdout","stderr","exitCode","timedOut","ms","error","files":[...],"skipped":n}
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint capCount, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertSidToStringSid(IntPtr sid, out string str);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint code);
}

static class Program
{
    static string Esc(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\"); else if (c == '\n') b.Append("\\n"); else if (c == '\r') b.Append("\\r"); else if (c == '\t') b.Append("\\t");
            else if (c < 32) b.Append("\\u" + ((int)c).ToString("x4")); else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static void Emit(string stdout, string stderr, long exit, bool timedOut, long ms, string error) { Emit(stdout, stderr, exit, timedOut, ms, error, new string[0], 0); }
    static void Emit(string stdout, string stderr, long exit, bool timedOut, long ms, string error, string[] files, int skipped)
    {
        StringBuilder f = new StringBuilder("[");
        for (int k = 0; k < files.Length; k++) { if (k > 0) f.Append(','); f.Append(Esc(files[k])); }
        f.Append(']');
        string j = "{\"stdout\":" + Esc(stdout) + ",\"stderr\":" + Esc(stderr) + ",\"exitCode\":" + exit + ",\"timedOut\":" + (timedOut ? "true" : "false") + ",\"ms\":" + ms + ",\"error\":" + Esc(error) + ",\"files\":" + f.ToString() + ",\"skipped\":" + skipped + "}";
        byte[] data = new UTF8Encoding(false).GetBytes(j);
        Stream o = Console.OpenStandardOutput(); o.Write(data, 0, data.Length); o.Flush();
    }

    // Grants the AppContainer read+execute (or full control) on a folder tree. Done once per folder (marker file), because propagation is slow.
    static void Grant(string dir, SecurityIdentifier sid, FileSystemRights rights, bool once)
    {
        string marker = Path.Combine(dir, ".omnigpt-acl-" + sid.Value.Substring(sid.Value.Length - 8));
        if (once && File.Exists(marker)) return;
        DirectoryInfo di = new DirectoryInfo(dir);
        DirectorySecurity sec = di.GetAccessControl();
        sec.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(sec);
        if (once) File.WriteAllText(marker, "ok");
    }

    // Builds a UTF-16 environment block: sorted NAME=value entries, each ending in NUL, and a final extra NUL.
    static IntPtr MakeEnv(string[] kv)
    {
        Array.Sort(kv, StringComparer.OrdinalIgnoreCase);
        StringBuilder b = new StringBuilder();
        foreach (string entry in kv) { b.Append(entry); b.Append((char)0); }
        b.Append((char)0);
        char[] chars = b.ToString().ToCharArray();
        IntPtr p = Marshal.AllocHGlobal((chars.Length + 2) * 2);
        Marshal.Copy(chars, 0, p, chars.Length);
        Marshal.WriteInt16(p, chars.Length * 2, 0);
        Marshal.WriteInt16(p, chars.Length * 2 + 2, 0);
        return p;
    }

    static bool IsLink(string p) { return (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0; }

    // input files: plain files directly in the folder, copied (never linked) into the run's input folder
    static void CopyInputs(string from, string to)
    {
        Directory.CreateDirectory(to);
        long total = 0; int n = 0;
        foreach (string f in Directory.GetFiles(from))
        {
            if (IsLink(f)) continue;
            long len = new FileInfo(f).Length;
            if (++n > 50 || total + len > 500L * 1024 * 1024) throw new Exception("too many or too large input files (50 files, 500 MB at most)");
            total += len;
            File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        }
    }

    // output files: everything the code wrote under output (4 folder levels at most), copied out without following
    // links or junctions, so code can never make the helper copy a file it could not read itself
    static void CollectOutputs(string dir, string rel, string dest, int depth, System.Collections.Generic.List<string> files, ref long total, ref int skipped)
    {
        foreach (string f in Directory.GetFiles(dir))
        {
            string name = rel.Length > 0 ? rel + "\\" + Path.GetFileName(f) : Path.GetFileName(f);
            long len = IsLink(f) ? -1 : new FileInfo(f).Length;
            if (len < 0 || files.Count >= 50 || total + len > 200L * 1024 * 1024) { skipped++; continue; }
            string target = Path.Combine(dest, name);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(f, target); total += len; files.Add(name);
        }
        foreach (string d in Directory.GetDirectories(dir))
        {
            if (IsLink(d) || depth >= 4) { skipped++; continue; }
            CollectOutputs(d, rel.Length > 0 ? rel + "\\" + Path.GetFileName(d) : Path.GetFileName(d), dest, depth + 1, files, ref total, ref skipped);
        }
    }

    static string Drain(Stream s, int cap, out bool truncated)
    {
        MemoryStream ms = new MemoryStream(); byte[] buf = new byte[8192]; truncated = false; int n;
        try { while ((n = s.Read(buf, 0, buf.Length)) > 0) { if (ms.Length < cap) ms.Write(buf, 0, (int)Math.Min(n, cap - ms.Length)); else truncated = true; } } catch (Exception) { }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    static int Main(string[] a)
    {
        DateTime t0 = DateTime.Now; string runDir = null;
        try
        {
            if (a.Length < 4) { Emit("", "", -1, false, 0, "usage: OmniGPT.Sandbox <root> <python|javascript> <seconds> <memoryMB>"); return 2; }
            string root = a[0], lang = a[1]; int secs = Math.Max(1, Math.Min(int.Parse(a[2]), 60)), mem = Math.Max(32, Math.Min(int.Parse(a[3]), 2048));
            string inDir = null, outDir = null;
            for (int k = 4; k + 1 < a.Length; k += 2) { if (a[k] == "--in") inDir = a[k + 1]; else if (a[k] == "--out") outDir = a[k + 1]; }
            if (inDir != null && !Directory.Exists(inDir)) { Emit("", "", -1, false, 0, "input folder not found"); return 2; }
            if (outDir != null) Directory.CreateDirectory(outDir);
            string code = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd();
            if (code.Length > 200000) { Emit("", "", -1, false, 0, "code is too large"); return 2; }

            string exe, args, file;
            if (lang == "python") { exe = Path.Combine(root, "sandbox", "python", "python.exe"); file = "main.py"; args = "-I -B -X utf8 main.py"; }
            else if (lang == "javascript") { exe = Path.Combine(root, "runtime", "node.exe"); file = "main.js"; args = "--max-old-space-size=" + Math.Max(32, mem / 2) + " --no-warnings -e \"require('vm').runInThisContext(require('fs').readFileSync('main.js','utf8'),{filename:'main.js'})\""; } // node resolves a script path by walking every parent folder, which an AppContainer forbids
            else { Emit("", "", -1, false, 0, "unsupported language: " + lang); return 2; }
            if (!File.Exists(exe)) { Emit("", "", -1, false, 0, lang + " runtime is not installed (" + exe + ")"); return 2; }

            // AppContainer identity
            IntPtr sidPtr;
            int hr = Native.CreateAppContainerProfile("OmniGPT.Sandbox", "OmniGPT sandbox", "Isolated code runner", IntPtr.Zero, 0, out sidPtr);
            if (hr != 0) { hr = Native.DeriveAppContainerSidFromAppContainerName("OmniGPT.Sandbox", out sidPtr); if (hr != 0) throw new Win32Exception(hr, "AppContainer unavailable"); }
            string sidStr; Native.ConvertSidToStringSid(sidPtr, out sidStr);
            SecurityIdentifier sid = new SecurityIdentifier(sidStr);

            string runs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OmniGPT", "sandbox", "runs");
            Directory.CreateDirectory(runs);
            Grant(runs, sid, FileSystemRights.Modify, true);
            Grant(Path.GetDirectoryName(exe), sid, FileSystemRights.ReadAndExecute, true);
            runDir = Path.Combine(runs, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(runDir);
            File.WriteAllText(Path.Combine(runDir, file), code, new UTF8Encoding(false));
            if (inDir != null) CopyInputs(inDir, Path.Combine(runDir, "input"));
            if (outDir != null) Directory.CreateDirectory(Path.Combine(runDir, "output"));

            // pipes (parent ends are not inherited)
            Native.SECURITY_ATTRIBUTES sa = new Native.SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)); sa.bInheritHandle = 1;
            IntPtr outR, outW, errR, errW;
            Native.CreatePipe(out outR, out outW, ref sa, 0); Native.CreatePipe(out errR, out errW, ref sa, 0);
            Native.SetHandleInformation(outR, 1, 0); Native.SetHandleInformation(errR, 1, 0);
            IntPtr nul = Native.CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);

            // attribute list: run as the AppContainer with no capabilities (so no network)
            Native.SECURITY_CAPABILITIES caps = new Native.SECURITY_CAPABILITIES(); caps.AppContainerSid = sidPtr;
            IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES))); Marshal.StructureToPtr(caps, capsPtr, false);
            IntPtr size = IntPtr.Zero; Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            IntPtr attr = Marshal.AllocHGlobal(size);
            if (!Native.InitializeProcThreadAttributeList(attr, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!Native.UpdateProcThreadAttribute(attr, 0, (IntPtr)0x20009, capsPtr, (IntPtr)Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());

            Native.STARTUPINFOEX si = new Native.STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX)); si.StartupInfo.dwFlags = 0x100; si.StartupInfo.hStdInput = nul; si.StartupInfo.hStdOutput = outW; si.StartupInfo.hStdError = errW; si.lpAttributeList = attr;
            string sysroot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
            IntPtr env = MakeEnv(new string[] { "SystemRoot=" + sysroot, "SystemDrive=" + (Environment.GetEnvironmentVariable("SystemDrive") ?? "C:"), "windir=" + sysroot, "TEMP=" + runDir, "TMP=" + runDir, "USERPROFILE=" + runDir, "LOCALAPPDATA=" + runDir, "APPDATA=" + runDir, "HOME=" + runDir, "PYTHONIOENCODING=utf-8", "PYTHONDONTWRITEBYTECODE=1", "NODE_SKIP_PLATFORM_CHECK=1" });
            StringBuilder cmd = new StringBuilder("\"" + exe + "\" " + args);

            Native.PROCESS_INFORMATION pi;
            if (!Native.CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x08000000 | 0x4, env, runDir, ref si, out pi)) { int le = Marshal.GetLastWin32Error(); throw new Exception("could not start the sandboxed process (Windows error " + le + ": " + new Win32Exception(le).Message + ")"); }
            Native.CloseHandle(outW); Native.CloseHandle(errW); Native.CloseHandle(nul);

            // job object: memory cap, one process, everything dies with the job
            IntPtr job = Native.CreateJobObjectW(IntPtr.Zero, null);
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            li.BasicLimitInformation.LimitFlags = 0x8 | 0x100 | 0x2000; li.BasicLimitInformation.ActiveProcessLimit = 1; li.ProcessMemoryLimit = (UIntPtr)((ulong)mem * 1024UL * 1024UL);
            IntPtr lip = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))); Marshal.StructureToPtr(li, lip, false);
            Native.SetInformationJobObject(job, 9, lip, Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            if (!Native.AssignProcessToJobObject(job, pi.hProcess)) { Native.TerminateProcess(pi.hProcess, 1); throw new Win32Exception(Marshal.GetLastWin32Error(), "could not apply limits"); }

            FileStream so = new FileStream(new SafeFileHandle(outR, true), FileAccess.Read), se = new FileStream(new SafeFileHandle(errR, true), FileAccess.Read);
            string o = "", e = ""; bool t1, t2;
            Thread to = new Thread(delegate () { o = Drain(so, 65536, out t1); }), te = new Thread(delegate () { e = Drain(se, 32768, out t2); });
            to.Start(); te.Start();
            Native.ResumeThread(pi.hThread);
            uint w = Native.WaitForSingleObject(pi.hProcess, (uint)(secs * 1000));
            bool timedOut = w == 0x102;
            if (timedOut) Native.TerminateJobObject(job, 1);
            to.Join(3000); te.Join(3000);
            uint code2 = 0; Native.GetExitCodeProcess(pi.hProcess, out code2);
            Native.CloseHandle(job);
            System.Collections.Generic.List<string> outFiles = new System.Collections.Generic.List<string>(); long outTotal = 0; int skipped = 0;
            string od = Path.Combine(runDir, "output");
            if (outDir != null && Directory.Exists(od)) { if (IsLink(od)) skipped++; else CollectOutputs(od, "", outDir, 0, outFiles, ref outTotal, ref skipped); } // the code may have swapped the folder itself for a link
            Emit(o, e, timedOut ? -1 : (long)(int)code2, timedOut, (long)(DateTime.Now - t0).TotalMilliseconds, "", outFiles.ToArray(), skipped);
            return 0;
        }
        catch (Exception ex) { Emit("", "", -1, false, (long)(DateTime.Now - t0).TotalMilliseconds, ex.Message); return 1; }
        finally { try { if (runDir != null) Directory.Delete(runDir, true); } catch (Exception) { } }
    }
}

