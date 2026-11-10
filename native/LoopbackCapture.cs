using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DshMeeting
{
    internal static class Program
    {
        private const int AUDCLNT_SHAREMODE_SHARED = 0;
        private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;

        private static volatile bool running = true;

        private static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        private static readonly Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        private static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        private static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PROPVARIANT pvar);

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumeratorComObject
        {
        }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            [PreserveSig] int GetDevice(string id, out IMMDevice device);
            [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
            [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
        }

        [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceCollection
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int Item(uint index, out IMMDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
                [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
            [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out int state);
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint cProps);
            [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
            [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
            [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
            [PreserveSig] int Commit();
        }

        [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioClient
        {
            [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration,
                long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
            [PreserveSig] int GetBufferSize(out uint bufferFrames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint padding);
            [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
            [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
            [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
            [PreserveSig] int Start();
            [PreserveSig] int Stop();
            [PreserveSig] int Reset();
            [PreserveSig] int SetEventHandle(IntPtr eventHandle);
            [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        }

        [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioCaptureClient
        {
            [PreserveSig] int GetBuffer(out IntPtr data, out uint numFrames, out uint flags,
                out ulong devicePosition, out ulong qpcPosition);
            [PreserveSig] int ReleaseBuffer(uint numFrames);
            [PreserveSig] int GetNextPacketSize(out uint numFrames);
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct WAVEFORMATEX
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct PROPERTYKEY
        {
            public Guid fmtid;
            public uint pid;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct PROPVARIANT
        {
            [FieldOffset(0)] public ushort vt;
            [FieldOffset(8)] public IntPtr pointerValue;
        }

        private static readonly PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY
        {
            fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
            pid = 14
        };

        private static string FriendlyName(IMMDevice device)
        {
            try
            {
                IPropertyStore store;
                if (device.OpenPropertyStore(0, out store) != 0) return "";
                PROPERTYKEY key = PKEY_Device_FriendlyName;
                PROPVARIANT pv;
                if (store.GetValue(ref key, out pv) != 0) return "";
                string name = pv.pointerValue == IntPtr.Zero ? "" : Marshal.PtrToStringUni(pv.pointerValue);
                PropVariantClear(ref pv);
                return name ?? "";
            }
            catch
            {
                return "";
            }
        }

        private static string Escape(string value)
        {
            if (value == null) return "";
            var builder = new StringBuilder();
            foreach (char c in value)
            {
                if (c == '\\') builder.Append("\\\\");
                else if (c == '"') builder.Append("\\\"");
                else if (c == '\n') builder.Append("\\n");
                else if (c == '\r') builder.Append("\\r");
                else if (c < 32) builder.Append(' ');
                else builder.Append(c);
            }
            return builder.ToString();
        }

        private static List<string> ListDevices(IMMDeviceEnumerator enumerator, int dataFlow)
        {
            var lines = new List<string>();
            IMMDeviceCollection collection;
            int hr = enumerator.EnumAudioEndpoints(dataFlow, 1, out collection);
            if (hr != 0) throw new COMException("EnumAudioEndpoints failed", hr);
            uint count;
            collection.GetCount(out count);
            for (uint i = 0; i < count; i++)
            {
                IMMDevice device;
                collection.Item(i, out device);
                string id;
                device.GetId(out id);
                lines.Add(id + "\t" + FriendlyName(device));
            }
            return lines;
        }

        private static bool TryGetDevice(IMMDeviceEnumerator enumerator, string id, int dataFlow, out IMMDevice device)
        {
            if (string.IsNullOrEmpty(id))
            {
                int hr = enumerator.GetDefaultAudioEndpoint(dataFlow, 0, out device);
                if (hr != 0) throw new COMException("GetDefaultAudioEndpoint failed", hr);
                return true;
            }
            int hr2 = enumerator.GetDevice(id, out device);
            if (hr2 != 0) throw new COMException("GetDevice failed", hr2);
            return true;
        }

        private static string Arg(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (String.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            }
            return null;
        }

        private static bool HasFlag(string[] args, string name)
        {
            foreach (string arg in args)
            {
                if (String.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        public static int Main(string[] args)
        {
            int init = CoInitializeEx(IntPtr.Zero, 0);
            try
            {
                object enumeratorObject = new MMDeviceEnumeratorComObject();
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)enumeratorObject;
                string source = Arg(args, "--source");
                bool microphone = String.Equals(source, "mic", StringComparison.OrdinalIgnoreCase);
                int dataFlow = microphone ? 1 : 0;

                if (HasFlag(args, "--list"))
                {
                    List<string> lines = ListDevices(enumerator, dataFlow);
                    string outPath = Arg(args, "--out");
                    if (outPath != null)
                    {
                        File.WriteAllLines(outPath, lines.ToArray(), new UTF8Encoding(false));
                    }
                    else
                    {
                        foreach (string line in lines) Console.WriteLine(line);
                    }
                    return 0;
                }

                int port;
                string portText = Arg(args, "--port");
                if (portText == null || !Int32.TryParse(portText, out port) || port < 1 || port > 65535)
                {
                    Console.Error.WriteLine("usage: LoopbackCapture --port <port> [--device <id>] [--source loopback|mic] [--list]");
                    return 2;
                }

                string deviceId = Arg(args, "--device");
                IMMDevice device;
                TryGetDevice(enumerator, deviceId, dataFlow, out device);
                string resolvedId;
                device.GetId(out resolvedId);
                string name = FriendlyName(device);

                Guid audioClientIid = IID_IAudioClient;
                object audioClientObject;
                int hr = device.Activate(ref audioClientIid, 0x17, IntPtr.Zero, out audioClientObject); // CLSCTX_ALL
                if (hr != 0) throw new COMException("Activate(IAudioClient) failed", hr);
                IAudioClient audioClient = (IAudioClient)audioClientObject;

                IntPtr formatPointer;
                hr = audioClient.GetMixFormat(out formatPointer);
                if (hr != 0) throw new COMException("GetMixFormat failed", hr);
                WAVEFORMATEX format = (WAVEFORMATEX)Marshal.PtrToStructure(formatPointer, typeof(WAVEFORMATEX));

                uint streamFlags = microphone ? 0u : AUDCLNT_STREAMFLAGS_LOOPBACK;
                hr = audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags,
                    2000000, 0, formatPointer, IntPtr.Zero);
                if (hr != 0) throw new COMException(microphone ? "Initialize(microphone) failed" : "Initialize(loopback) failed", hr);

                Guid captureIid = IID_IAudioCaptureClient;
                object captureObject;
                hr = audioClient.GetService(ref captureIid, out captureObject);
                if (hr != 0) throw new COMException("GetService(IAudioCaptureClient) failed", hr);
                IAudioCaptureClient capture = (IAudioCaptureClient)captureObject;

                TcpClient client = new TcpClient();
                client.NoDelay = true;
                client.Connect("127.0.0.1", port);
                NetworkStream stream = client.GetStream();

                string formatName;
                if (format.wFormatTag == 3)
                {
                    formatName = "f32";
                }
                else if (format.wFormatTag == 1 && format.wBitsPerSample == 16)
                {
                    formatName = "s16";
                }
                else if (format.wFormatTag == 0xFFFE && format.cbSize >= 22)
                {
                    Guid subFormat = (Guid)Marshal.PtrToStructure(IntPtr.Add(formatPointer, 24), typeof(Guid));
                    if (subFormat == new Guid("00000003-0000-0010-8000-00AA00389B71")) formatName = "f32";
                    else if (subFormat == new Guid("00000001-0000-0010-8000-00AA00389B71")) formatName = "s16";
                    else formatName = "unknown";
                }
                else
                {
                    formatName = "unknown";
                }
                string header = "{\"sampleRate\":" + format.nSamplesPerSec +
                    ",\"channels\":" + format.nChannels +
                    ",\"bits\":" + format.wBitsPerSample +
                    ",\"format\":\"" + formatName + "\"" +
                    ",\"blockAlign\":" + format.nBlockAlign +
                    ",\"source\":\"" + (microphone ? "mic" : "loopback") + "\"" +
                    ",\"deviceId\":\"" + Escape(resolvedId) + "\"" +
                    ",\"deviceName\":\"" + Escape(name) + "\"}\n";
                byte[] headerBytes = Encoding.UTF8.GetBytes(header);
                stream.Write(headerBytes, 0, headerBytes.Length);

                hr = audioClient.Start();
                if (hr != 0) throw new COMException("Start failed", hr);

                Console.CancelKeyPress += delegate { running = false; };
                AppDomain.CurrentDomain.ProcessExit += delegate { running = false; };

                int blockAlign = format.nBlockAlign;
                int bytesPerSecond = (int)(format.nSamplesPerSec * blockAlign);
                byte[] scratch = new byte[Math.Max(bytesPerSecond / 10, blockAlign * 512)];
                byte[] silence = new byte[scratch.Length];
                DateTime started = DateTime.UtcNow;
                string secondsText = Arg(args, "--seconds");
                int seconds = 0;
                if (secondsText != null) Int32.TryParse(secondsText, out seconds);

                while (running)
                {
                    if (seconds > 0 && (DateTime.UtcNow - started).TotalSeconds >= seconds) break;
                    uint packetSize;
                    hr = capture.GetNextPacketSize(out packetSize);
                    if (hr != 0) throw new COMException("GetNextPacketSize failed", hr);
                    if (packetSize == 0)
                    {
                        Thread.Sleep(8);
                        continue;
                    }
                    while (packetSize > 0)
                    {
                        IntPtr data;
                        uint frames;
                        uint flags;
                        ulong devicePosition;
                        ulong qpcPosition;
                        hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                        if (hr != 0) throw new COMException("GetBuffer failed", hr);
                        int bytes = (int)frames * blockAlign;
                        if (bytes > 0)
                        {
                            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
                            {
                                while (bytes > 0)
                                {
                                    int chunk = Math.Min(bytes, silence.Length);
                                    stream.Write(silence, 0, chunk);
                                    bytes -= chunk;
                                }
                            }
                            else
                            {
                                if (bytes <= scratch.Length)
                                {
                                    Marshal.Copy(data, scratch, 0, bytes);
                                    stream.Write(scratch, 0, bytes);
                                }
                                else
                                {
                                    byte[] large = new byte[bytes];
                                    Marshal.Copy(data, large, 0, bytes);
                                    stream.Write(large, 0, bytes);
                                }
                            }
                        }
                        capture.ReleaseBuffer(frames);
                        hr = capture.GetNextPacketSize(out packetSize);
                        if (hr != 0) throw new COMException("GetNextPacketSize failed", hr);
                    }
                }

                audioClient.Stop();
                stream.Flush();
                client.Close();
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.ToString());
                return 1;
            }
            finally
            {
                CoUninitialize();
            }
        }
    }
}
