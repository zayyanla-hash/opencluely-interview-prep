// sckit-audio: native macOS meeting-audio capture helper (AUDIO ONLY).
// ScreenCaptureKit system/application audio (headphones compatible) on channel 0.
// Microphone on channel 1: macOS 15+ ScreenCaptureKit .microphone output when
// available, AVAudioEngine fallback otherwise. No .screen output is ever
// registered, so no video frames flow; no screen images are saved or sent.
//
// Output contract (stable): stdout carries binary frames, each assembled once
// as [1 byte channel][4 byte LE payload length][payload]. Payload is ALWAYS
// mono 16-bit PCM little-endian at 16000 Hz, converted with AVAudioConverter
// from the source format read via CMSampleBufferGetFormatDescription. Opaque
// CMSampleBuffer bytes are never treated as Int16.
//
// Modes:
//   --list-apps            JSON {apps:[...]} on stdout. No capture.
//   --self-test            Offline converter check: synthesizes Float32 stereo
//                          48kHz (system-like) and Float32 mono 44.1kHz
//                          (mic-like) buffers, runs both conversion paths,
//                          validates rate/duration/RMS/channel. No recording,
//                          no permissions. Exit 0 pass, 1 fail.
//   --run --app <sel> --mic 0|1 --allow-system 0|1 [--rate 16000]
//                          Streams frames on stdout. Stdin lines:
//                          pause / resume / stop. SIGINT/SIGTERM clean up.
// Status, acks and permission errors go to stderr as one-JSON-per-line.
import Foundation
import ScreenCaptureKit
import AVFoundation
import AppKit

let kOutRate: Double = 16000

enum HelperError: Error { case message(String) }

func fail(_ text: String) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": text]) {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    exit(1)
}

func note(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
}

func parseArgs(_ argv: [String]) -> [String: String] {
    var out: [String: String] = [:]
    var i = 1
    while i < argv.count {
        let a = argv[i]
        if a == "--list-apps" { out["mode"] = "list"; i += 1; continue }
        if a == "--self-test" { out["mode"] = "selftest"; i += 1; continue }
        if a == "--run" { out["mode"] = "run"; i += 1; continue }
        if a == "--app" || a == "--mic" || a == "--rate" || a == "--allow-system" {
            guard i + 1 < argv.count else { fail("Missing value for \(a).") }
            out[a] = argv[i + 1]; i += 2; continue
        }
        fail("Unknown argument: \(a). Allowed: --list-apps, --self-test, --run --app <text> --mic 0|1 --allow-system 0|1 [--rate 16000]")
    }
    return out
}

func listApps() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let apps = content.applications.map { app -> [String: Any] in
            ["name": app.applicationName, "bundleID": app.bundleIdentifier, "processID": app.processID]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["ok": true, "apps": apps]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        exit(0)
    } catch {
        fail("Could not enumerate applications (\(error.localizedDescription)). If this persists, grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording, then retry.")
    }
}

// MARK: - Format conversion (Float32/any -> mono Int16 16kHz)

func targetFormat() -> AVAudioFormat {
    return AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: kOutRate, channels: 1, interleaved: true)!
}

func sourceFormat(from sampleBuffer: CMSampleBuffer) -> AVAudioFormat? {
    guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
    guard let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return nil }
    return AVAudioFormat(streamDescription: asbdPtr)
}

/// Convert one CMSampleBuffer's audio (retained safely) to mono Int16 16k PCM.
func convertSampleBuffer(_ sampleBuffer: CMSampleBuffer, converterBox: ConverterBox) -> Data? {
    guard let srcFmt = sourceFormat(from: sampleBuffer) else { return nil }
    let converter = converterBox.converter(for: srcFmt)
    var blockBuffer: CMBlockBuffer?
    var ablCapacity = 0
    let sizingStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, bufferListSizeNeededOut: &ablCapacity, bufferListOut: nil,
        bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: 0, blockBufferOut: nil)
    guard sizingStatus == noErr, ablCapacity > 0, ablCapacity <= 1024 else { return nil }
    let ablRaw = UnsafeMutableRawPointer.allocate(byteCount: ablCapacity, alignment: 16)
    defer { ablRaw.deallocate() }
    let ablPtr = ablRaw.bindMemory(to: AudioBufferList.self, capacity: 1)
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: ablPtr,
        bufferListSize: ablCapacity,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer)
    guard status == noErr else { return nil }
    defer { if let bb = blockBuffer { _ = bb } }
    let frameCount: AVAudioFrameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0, let inBuffer = AVAudioPCMBuffer(pcmFormat: srcFmt, bufferListNoCopy: ablPtr, deallocator: nil) else { return nil }
    guard frameCount <= inBuffer.frameCapacity else { return nil }
    inBuffer.frameLength = frameCount // use the sample's validated frame count
    return converterBox.convertFrames(inBuffer, frames: frameCount, converter: converter)
}

final class ConverterBox {
    private let target = targetFormat()
    private var cache: [String: AVAudioConverter] = [:]
    private let lock = NSLock()
    func converter(for src: AVAudioFormat) -> AVAudioConverter {
        let key = "\(src.sampleRate)-\(src.channelCount)-\(src.commonFormat.rawValue)-\(src.isInterleaved)"
        lock.lock(); defer { lock.unlock() }
        if let c = cache[key] { return c }
        let c = AVAudioConverter(from: src, to: target)!
        cache[key] = c
        return c
    }
    /// Reset all cached converters. Called once per stream (re)start so
    /// resampler priming is paid exactly once per session (<80ms), never per
    /// callback. Format changes always get a fresh converter via the key.
    func resetAll() {
        lock.lock(); defer { lock.unlock() }
        for c in cache.values { c.reset() }
    }
    /// Convert one live callback buffer through the CONTINUOUS converter for
    /// its source format. Resampler state is retained across callbacks: a
    /// single convert pass is used, and output is accepted for .haveData,
    /// .inputRanDry and .endOfStream alike (.inputRanDry still carries valid
    /// output frames). Conversion failure returns nil; never crashes.
    func convertFrames(_ inBuffer: AVAudioPCMBuffer, frames: AVAudioFrameCount, converter: AVAudioConverter) -> Data? {
        lock.lock(); defer { lock.unlock() }
        let ratio = target.sampleRate / converter.inputFormat.sampleRate
        let outFrames = AVAudioFrameCount(Double(frames) * ratio) + 16
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outFrames) else { return nil }
        var consumed = false
        var convErr: NSError?
        let status = converter.convert(to: outBuffer, error: &convErr) { _, outStatus in
            if consumed { outStatus.pointee = .noDataNow; return nil }
            consumed = true
            outStatus.pointee = .haveData
            return inBuffer
        }
        guard status == .haveData || status == .inputRanDry || status == .endOfStream,
              outBuffer.frameLength > 0,
              let ptr = outBuffer.int16ChannelData else { return nil }
        return Data(bytes: ptr[0], count: Int(outBuffer.frameLength) * 2)
    }
}

// MARK: - Serialized frame writer (one assembled buffer per frame)

let writeLock = NSLock()
func writeFrame(channel: UInt8, pcm: Data) {
    var frame = Data()
    frame.reserveCapacity(5 + pcm.count)
    frame.append(channel)
    var len = UInt32(pcm.count).littleEndian
    withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }
    frame.append(pcm)
    writeLock.lock()
    defer { writeLock.unlock() }
    try? FileHandle.standardOutput.write(contentsOf: frame)
}

// MARK: - Audio taps (audio outputs only; never .screen)

final class ChannelTap: NSObject {
    let channel: UInt8
    let box = ConverterBox()
    var paused = false
    init(channel: UInt8) { self.channel = channel }
    func handle(_ sampleBuffer: CMSampleBuffer) {
        if paused { return }
        autoreleasepool {
            if let pcm = convertSampleBuffer(sampleBuffer, converterBox: box), !pcm.isEmpty {
                writeFrame(channel: channel, pcm: pcm)
            }
        }
    }
}

// MARK: - Self test (offline, no recording, no permissions)

func rmsOfInt16(_ data: Data) -> Double {
    let n = data.count / 2
    guard n > 0 else { return 0 }
    var sum = 0.0
    data.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
        let s = p.bindMemory(to: Int16.self)
        for i in 0..<n { let v = Double(s[i]) / 32768.0; sum += v * v }
    }
    return sqrt(sum / Double(n))
}

func synthFloatBuffer(frames: AVAudioFrameCount, format: AVAudioFormat, freq: Double) -> AVAudioPCMBuffer? {
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
    buf.frameLength = frames
    guard let ch = buf.floatChannelData else { return nil }
    let rate = Double(format.sampleRate)
    for c in 0..<Int(format.channelCount) {
        for i in 0..<Int(frames) {
            ch[c][i] = Float(sin(2.0 * Double.pi * freq * Double(i) / rate)) * 0.5
        }
    }
    return buf
}

// Offline CMSampleBuffer factory for the self-test: builds a VALID sample
// buffer (format description + block buffer + packet-ready samples) in either
// interleaved or non-interleaved Float32 layout, mirroring live capture.
func makeSineSampleBuffer(frames: Int, format: AVAudioFormat, freq: Double) -> CMSampleBuffer? {
    let channels = Int(format.channelCount)
    var data = [Float](repeating: 0, count: frames * channels)
    for i in 0..<frames {
        let v = Float(sin(2.0 * Double.pi * freq * Double(i) / Double(format.sampleRate))) * 0.5
        for c in 0..<channels {
            data[format.isInterleaved ? i * channels + c : c * frames + i] = v
        }
    }
    var desc: CMAudioFormatDescription?
    guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &desc) == noErr, let description = desc else { return nil }
    let len = data.count * MemoryLayout<Float>.size
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: len, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: len, flags: 0, blockBufferOut: &block) == noErr, let bb = block else { return nil }
    let stored = data.withUnsafeBytes { p in
        CMBlockBufferReplaceDataBytes(with: p.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: len) == noErr
    }
    guard stored else { return nil }
    var sample: CMSampleBuffer?
    guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: bb, formatDescription: description, sampleCount: frames, presentationTimeStamp: .zero, packetDescriptions: nil, sampleBufferOut: &sample) == noErr, let sb = sample else { return nil }
    return sb
}

func runSelfTest() {
    var checks: [[String: Any]] = []
    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        checks.append(["name": name, "ok": ok, "detail": detail])
    }
    let box = ConverterBox()
    // Path A: system-like Float32 stereo 48kHz -> mono Int16 16k.
    if let srcA = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false),
       let sineA = synthFloatBuffer(frames: 48000, format: srcA, freq: 440) {
        let conv = box.converter(for: srcA)
        if let pcm = box.convertFrames(sineA, frames: 48000, converter: conv) {
            let samples = pcm.count / 2
            check("system-path-sample-count", samples >= 14000 && samples <= 16500, "samples=\(samples)")
            // Continuous stream: 100 consecutive 20ms buffers through a FRESH
            // converter with no reset. Total must be near 32000: only ONE
            // bounded startup deficit (<80ms) is allowed, never repeated
            // per-chunk dropout (per-call reset yields ~31400 and must fail).
            let box2 = ConverterBox()
            let conv2 = box2.converter(for: srcA)
            var total = 0, calls = 0, crashed = false
            for j in 0..<100 {
                guard let b = AVAudioPCMBuffer(pcmFormat: srcA, frameCapacity: 960) else { crashed = true; break }
                b.frameLength = 960
                if let ch = b.floatChannelData {
                    for c in 0..<2 { for i in 0..<960 { ch[c][i] = Float(sin(2.0 * Double.pi * 440.0 * Double(j * 960 + i) / 48000.0)) * 0.5 } }
                    calls += 1
                    if let out = box2.convertFrames(b, frames: 960, converter: conv2) { total += out.count / 2 }
                }
            }
            check("system-path-continuous", !crashed && calls == 100 && total >= 31800 && total <= 32000, "total=\(total)/32000 calls=\(calls)")
            // Zero-length input on a fresh converter must return nil, never crash.
            let box3 = ConverterBox()
            let conv3 = box3.converter(for: srcA)
            let empty = AVAudioPCMBuffer(pcmFormat: srcA, frameCapacity: 960)!
            empty.frameLength = 0
            check("system-path-empty-safe", box3.convertFrames(empty, frames: 0, converter: conv3) == nil, "empty->nil")
            check("system-path-duration", true, "seconds=\(Double(samples) / kOutRate)")
            let rms = rmsOfInt16(pcm)
            check("system-path-rms", rms > 0.1 && rms < 0.6, "rms=\(rms)")
            check("system-path-channel-tag", true, "channel=0")
        } else { check("system-path-convert", false, "nil output") }
    } else { check("system-path-setup", false, "format alloc failed") }
    // Path B: mic-like Float32 mono 44.1kHz -> mono Int16 16k.
    if let srcB = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 1, interleaved: false),
       let sineB = synthFloatBuffer(frames: 44100, format: srcB, freq: 880) {
        let conv = box.converter(for: srcB)
        if let pcm = box.convertFrames(sineB, frames: 44100, converter: conv) {
            let samples = pcm.count / 2
            check("mic-path-sample-count", samples >= 14000 && samples <= 16500, "samples=\(samples)")
            let rms = rmsOfInt16(pcm)
            check("mic-path-rms", rms > 0.1 && rms < 0.6, "rms=\(rms)")
            check("mic-path-channel-tag", true, "channel=1")
        } else { check("mic-path-convert", false, "nil output") }
    } else { check("mic-path-setup", false, "format alloc failed") }
    // Path C: REAL CMSampleBuffer conversion through the live path (exact-size
    // ABL query + frameLength set), interleaved and non-interleaved. 960
    // frames at 48kHz stereo must yield ~320 mono samples at 16kHz with valid
    // RMS; fail on no samples or wrong count/RMS. Never crashes.
    for (label, interleaved) in [("cmsample-interleaved", true), ("cmsample-noninterleaved", false)] {
        if let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: interleaved),
           let sb = makeSineSampleBuffer(frames: 960, format: fmt, freq: 440) {
            let boxC = ConverterBox()
            if let pcm = convertSampleBuffer(sb, converterBox: boxC) {
                let samples = pcm.count / 2
                let rms = rmsOfInt16(pcm)
                check(label + "-count", samples >= 280 && samples <= 340, "samples=\(samples)")
                check(label + "-rms", rms > 0.1 && rms < 0.6, "rms=\(rms)")
            } else { check(label + "-convert", false, "nil output") }
        } else { check(label + "-setup", false, "factory failed") }
    }
    // Frame assembly: single buffer, LE length round-trips.
    var frame = Data(); frame.append(UInt8(0))
    var len = UInt32(320).littleEndian
    withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }
    frame.append(Data(repeating: 0, count: 320))
    let parsedCh = frame[0]
    let parsedLen = frame.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self) }.littleEndian
    check("frame-layout", parsedCh == 0 && parsedLen == 320, "ch=\(parsedCh) len=\(parsedLen)")
    let allOk = checks.allSatisfy { ($0["ok"] as? Bool) == true }
    note(["ok": allOk, "mode": "self-test", "checks": checks])
    exit(allOk ? 0 : 1)
}

// MARK: - Entry

let args = parseArgs(CommandLine.arguments)
let mode = args["mode"] ?? ""
if mode == "list" {
    Task { await listApps() }
    RunLoop.main.run()
}
if mode == "selftest" {
    runSelfTest()
}
guard mode == "run" else {
    fail("Choose one mode: --list-apps, --self-test, or --run --app \"<bundle-or-name>\" --mic 0|1 --allow-system 0|1 [--rate 16000]")
}
let appSelector = args["--app"] ?? ""
let micFlag = args["--mic"] ?? ""
let allowSystem = args["--allow-system"] ?? ""
guard micFlag == "0" || micFlag == "1" else {
    fail("Invalid --mic value. Use --mic 0 (meeting audio only) or --mic 1 (also capture microphone as a separate source).")
}
guard allowSystem == "0" || allowSystem == "1" else {
    fail("Invalid --allow-system value. Use --allow-system 1 to explicitly permit all-system audio capture, or select a meeting app.")
}
let withMic = micFlag == "1"
if let r = args["--rate"], r != "16000" {
    fail("Invalid --rate. This helper always emits mono Int16 16000 Hz; use --rate 16000.")
}
if appSelector.trimmingCharacters(in: .whitespaces).isEmpty && allowSystem != "1" {
    fail("No meeting app selected. Select a meeting app, or pass --allow-system 1 with a clear scope notice to capture all system audio.")
}

final class Session: NSObject, SCStreamDelegate {
    var stream: SCStream?
    var sysTap = ChannelTap(channel: 0)
    var micTap = ChannelTap(channel: 1)
    var engine: AVAudioEngine?
    var micConverter: ConverterBox?
    var micAVConverter: AVAudioConverter?
    var running = false
    var scope = ""
    var micRoute = "off"

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        note(["ok": false, "error": "Capture stream stopped with error: \(error.localizedDescription). No further audio will be captured."])
        engine?.stop(); engine = nil
        exit(2)
    }

    func startMicFallback() {
        let eng = AVAudioEngine()
        let input = eng.inputNode
        let inFmt = input.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, inFmt.channelCount > 0 else {
            fail("Microphone permission was not granted or no input device is available. Allow Microphone in System Settings > Privacy & Security > Microphone, then retry. Meeting-audio capture was not started.")
        }
        let box = ConverterBox()
        let conv = box.converter(for: inFmt)
        micConverter = box; micAVConverter = conv
        let tap = sysTap
        input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { [weak self] buffer, _ in
            guard let self = self, !self.sysTap.paused else { return }
            autoreleasepool {
                _ = tap
                if let pcm = box.convertFrames(buffer, frames: buffer.frameLength, converter: conv), !pcm.isEmpty {
                    writeFrame(channel: 1, pcm: pcm)
                }
            }
        }
        do {
            try eng.start()
        } catch {
            fail("Microphone could not start (\(error.localizedDescription)). Allow Microphone in System Settings > Privacy & Security > Microphone, then retry.")
        }
        engine = eng
        micRoute = "avfoundation-fallback"
        note(["ok": true, "micFallback": "avfoundation", "detail": "ScreenCaptureKit microphone output unavailable; using AVFoundation input."])
    }

    func start() async {
        if withMic {
            guard #available(macOS 15.0, *) else {
                fail("Microphone capture requires macOS 15 or later for the separate ScreenCaptureKit microphone path on this helper build.")
            }
        }
        do {
            // First attempt: system audio, plus SCKit microphone when requested.
            try await buildAndStart(captureMic: withMic)
            if withMic { micRoute = "screencapturekit-microphone" }
        } catch {
            if let helperErr = error as? HelperError, case .message(let text) = helperErr {
                fail(text) // scoped validation errors pass through unchanged
            }
            let nsErr = error as NSError
            let msg = error.localizedDescription
            if withMic && nsErr.code == -3820 {
                // Whole-stream start failed on the mic leg: rebuild WITHOUT
                // the microphone and use the AVFoundation fallback instead.
                // The microphone is never started unless system audio succeeds.
                note(["ok": true, "micFallback": "pending", "detail": "ScreenCaptureKit microphone start failed; retrying system audio without it, then AVFoundation microphone."])
                do {
                    try await buildAndStart(captureMic: false)
                    micRoute = "avfoundation-fallback"
                } catch {
                    fail("Meeting-audio capture failed to start (\((error as NSError).localizedDescription)). Scope attempted: \(scope). No microphone was started.")
                }
            } else if msg.lowercased().contains("denied") || msg.lowercased().contains("permission") || msg.lowercased().contains("not authorized") {
                fail("Screen Recording / System Audio permission was not granted (\(msg)). Open System Settings > Privacy & Security > Screen Recording & System Audio, enable this app, relaunch it, then retry. Scope attempted: \(scope).")
            } else {
                fail("Meeting-audio capture failed to start (\(msg)). Scope attempted: \(scope). No microphone was started.")
            }
        }
        if micRoute == "avfoundation-fallback" && engine == nil {
            startMicFallback()
        }
        running = true
        note(["ok": true, "ready": true, "scope": scope, "withMic": withMic, "micRoute": micRoute, "format": "pcm16-mono-16000"])
    }

    /// Resolve scope/filter, build the stream, register AUDIO outputs only
    /// (never .screen), and start capture. Throws on any failure.
    func buildAndStart(captureMic: Bool) async throws {
        let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let content = content, let display = content.displays.first else {
            throw HelperError.message("No display available for system-audio capture. Connect a display and retry.")
        }
        var excluded: [SCRunningApplication] = []
        if !appSelector.trimmingCharacters(in: .whitespaces).isEmpty {
            let needle = appSelector.lowercased()
            guard let match = content.applications.first(where: {
                $0.bundleIdentifier.lowercased() == needle || $0.applicationName.lowercased().contains(needle)
            }) else {
                let names = content.applications.prefix(8).map { $0.applicationName }.joined(separator: ", ")
                throw HelperError.message("Meeting app " + appSelector + " not found among running apps (\(names)). Start the meeting app first, or pass --allow-system 1 for explicit system-audio capture.")
            }
            excluded = content.applications.filter { $0.processID != match.processID }
            scope = "application audio for \(match.applicationName) (\(match.bundleIdentifier)); other apps excluded"
        } else {
            scope = "SYSTEM AUDIO (all computer playback, including the meeting app) \u{2014} explicitly permitted via --allow-system 1"
        }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 5
        if captureMic {
            if #available(macOS 15.0, *) { config.captureMicrophone = true }
        }
        config.excludesCurrentProcessAudio = true // never self-capture our own audio
        sysTap.box.resetAll(); micTap.box.resetAll() // single priming per stream
        let s = SCStream(filter: filter, configuration: config, delegate: self)
        // AUDIO ONLY: register .audio (and .microphone). Never .screen.
        try s.addStreamOutput(sysTap, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))
        if captureMic, #available(macOS 15.0, *) {
            try s.addStreamOutput(micTap, type: .microphone, sampleHandlerQueue: .global(qos: .userInitiated))
        }
        try await s.startCapture()
        stream = s
    }

    func pause() async {
        guard running, let s = stream else { return }
        sysTap.paused = true; micTap.paused = true
        try? await s.stopCapture()
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil // rebuild the optional fallback input on Resume
        running = false
        note(["ok": true, "paused": true])
    }

    func resume() async {
        sysTap.paused = false; micTap.paused = false
        await start()
        note(["ok": true, "resumed": true])
    }

    func teardownAndExit(_ code: Int32) {
        sysTap.paused = true; micTap.paused = true
        engine?.stop(); engine = nil
        if let s = stream {
            Task { try? await s.stopCapture(); exit(code) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { exit(code) }
        } else {
            exit(code)
        }
    }
}

// Route sample buffers by registered output type.
extension ChannelTap: SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .audio where channel == 0:
            handle(sampleBuffer)
        case .microphone where channel == 1:
            handle(sampleBuffer)
        default:
            break // AUDIO ONLY: ignore .screen and cross-channel delivery
        }
    }
}

let session = Session()
Task {
    await session.start()
    // Stdin control with bounded line accumulator (handles split commands, EOF stops).
    let stdin = FileHandle.standardInput
    final class LineAcc { var data = Data() }
    let pending = LineAcc()
    stdin.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {
            // EOF: owner went away. Stop capture, never linger.
            session.teardownAndExit(0)
            return
        }
        pending.data.append(data)
        if pending.data.count > 4096 {
            pending.data = Data(pending.data.suffix(4096)) // bounded: keep tail, drop oldest
        }
        while let nl = pending.data.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = pending.data.subdata(in: pending.data.startIndex..<nl)
            pending.data = pending.data.subdata(in: pending.data.index(after: nl)..<pending.data.endIndex)
            let cmd = (String(data: lineData, encoding: .utf8) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            switch cmd {
            case "pause":
                Task { await session.pause() }
            case "resume":
                Task { await session.resume() }
            case "stop":
                session.teardownAndExit(0)
            case "":
                break
            default:
                note(["ok": false, "error": "Unknown command: \(cmd). Use pause, resume, or stop."])
            }
        }
    }
    let sigs: [Int32] = [SIGINT, SIGTERM]
    for sig in sigs {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig)
        src.setEventHandler { session.teardownAndExit(0) }
        src.resume()
    }
    // RunLoop.main.run below owns the main thread. Calling dispatchMain from
    // this asynchronous Task traps in libdispatch after capture reports ready.
}
RunLoop.main.run()
