// 绿色目录启动器。只做四件事：自愈 pyvenv.cfg、选定数据根、拉起服务、打开浏览器。
// 不读业务文件，不判断步骤。服务进程只认 argv[2] 给出的数据根。
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class Launcher {
    const uint KillOnJobClose = 0x2000;

    static IntPtr job;

    static int Main(string[] args) {
        bool healOnly = false;
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--heal-only") healOnly = true;
            else if (args[i] == "--root" && i + 1 < args.Length) root = Path.GetFullPath(args[++i]);
            else {
                Console.Error.WriteLine("用法：slice-studio.exe [--heal-only] [--root 目录]");
                return 2;
            }
        }
        try {
            Heal(root);
            string data = ChooseData(root);
            Console.WriteLine("data=" + data);
            if (healOnly) return 0;
            return Serve(root, data);
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    // home 必须等于当前 tools/python/base。换机器后旧的绝对路径会让 venv 直接起不来。
    // 这份 venv 除了规划里的三行，还有 executable / command，同样是绝对路径，一并改到新位置。
    static void Heal(string root) {
        string cfg = Path.Combine(root, "tools", "python", "venv", "pyvenv.cfg");
        string baseDir = Path.GetFullPath(Path.Combine(root, "tools", "python", "base"));
        if (!File.Exists(cfg)) throw new InvalidOperationException("找不到 " + cfg);
        string[] lines = File.ReadAllLines(cfg);
        string py = Path.Combine(baseDir, "python.exe");
        string venv = Path.GetFullPath(Path.Combine(root, "tools", "python", "venv"));
        bool changed = false;
        for (int i = 0; i < lines.Length; i++) {
            string key = KeyOf(lines[i]);
            string next = lines[i];
            if (key == "home") next = "home = " + baseDir;
            else if (key == "executable") next = "executable = " + py;
            else if (key == "command") next = "command = " + py + " -m venv " + venv;
            if (next != lines[i]) {
                lines[i] = next;
                changed = true;
            }
        }
        bool hasHome = false;
        foreach (string line in lines) if (KeyOf(line) == "home") hasHome = true;
        if (!hasHome) {
            var withHome = new string[lines.Length + 1];
            withHome[0] = "home = " + baseDir;
            Array.Copy(lines, 0, withHome, 1, lines.Length);
            lines = withHome;
            changed = true;
        }
        if (!changed) return;
        File.WriteAllLines(cfg, lines, new UTF8Encoding(false));
        Console.WriteLine("已把 pyvenv.cfg 的 home 指到 " + baseDir);
    }

    static string KeyOf(string line) {
        int eq = line.IndexOf('=');
        if (eq < 0) return "";
        return line.Substring(0, eq).Trim().ToLowerInvariant();
    }

    static string ChooseData(string root) {
        if (CanWrite(root)) return root;
        string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "slice-studio");
        Directory.CreateDirectory(fallback);
        Console.WriteLine("程序目录不可写，数据改放到 " + fallback);
        return fallback;
    }

    static bool CanWrite(string dir) {
        string probe = Path.Combine(dir, ".slice-write-probe");
        try {
            using (var fs = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            File.Delete(probe);
            return true;
        } catch {
            try { if (File.Exists(probe)) File.Delete(probe); } catch { }
            return false;
        }
    }

    static int Serve(string root, string data) {
        string node = Path.Combine(root, "tools", "node", "node.exe");
        string script = Path.Combine(root, "src", "server", "main.ts");
        if (!File.Exists(node)) throw new InvalidOperationException("找不到 " + node);
        if (!File.Exists(script)) throw new InvalidOperationException("找不到 " + script);
        string scratch = Path.Combine(data, "work", "_scratch");
        Directory.CreateDirectory(scratch);
        var psi = new ProcessStartInfo {
            FileName = node,
            Arguments = Quote(script) + " " + Quote(data),
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.EnvironmentVariables["TEMP"] = scratch;
        psi.EnvironmentVariables["TMP"] = scratch;
        Process p = Process.Start(psi);
        if (p == null) throw new InvalidOperationException("服务进程没有拉起来");
        try { AttachKillOnClose(p); }
        catch (Exception e) { Console.Error.WriteLine("没能把服务放进作业（关掉窗口后它可能还在）：" + e.Message); }
        Console.WriteLine("pid=" + p.Id);
        p.ErrorDataReceived += (s, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
        p.BeginErrorReadLine();
        Console.CancelKeyPress += (s, e) => {
            e.Cancel = true;
            try { if (!p.HasExited) p.Kill(); } catch { }
        };
        bool opened = false;
        string line;
        while ((line = p.StandardOutput.ReadLine()) != null) {
            Console.WriteLine(line);
            if (opened) continue;
            Match m = Regex.Match(line, @"http://127\.0\.0\.1:\d+");
            if (!m.Success) continue;
            opened = true;
            Console.WriteLine("url=" + m.Value);
            if (Environment.GetEnvironmentVariable("SLICE_NO_BROWSER") == "1") continue;
            try {
                Process.Start(new ProcessStartInfo(m.Value) { UseShellExecute = true });
            } catch (Exception e) {
                Console.Error.WriteLine("没能打开浏览器：" + e.Message + "。请手动打开 " + m.Value);
            }
        }
        p.WaitForExit();
        return p.ExitCode;
    }

    static string Quote(string s) {
        if (s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static void AttachKillOnClose(Process child) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = KillOnJobClose;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        try {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, 9, ptr, (uint)length)) throw new Win32Exception();
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
        if (!AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception();
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
