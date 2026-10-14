import Foundation
import ScreenCaptureKit
import AVFoundation
let kOutRate:Double=16000
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
    var needed = 0
    let query=CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &needed, bufferListOut:nil, bufferListSize:0, blockBufferAllocator:nil, blockBufferMemoryAllocator:nil, flags:0, blockBufferOut:nil)
    print("Size query",query,"needed",needed)
    let ablCapacity = needed
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
    print("ABL status",status,"buffers",ablPtr.pointee.mNumberBuffers,"bytes",ablPtr.pointee.mBuffers.mDataByteSize,"src",srcFmt); guard status == noErr else { return nil }
    defer { if let bb = blockBuffer { _ = bb } }
    let frameCount: AVAudioFrameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0, let inBuffer = AVAudioPCMBuffer(pcmFormat: srcFmt, bufferListNoCopy: ablPtr, deallocator: nil) else { return nil }
    print("No-copy",frameCount,"capacity",inBuffer.frameCapacity,"length",inBuffer.frameLength); guard frameCount <= inBuffer.frameCapacity else { return nil }
    inBuffer.frameLength = frameCount // the no-copy initializer leaves length at zero
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
        print("Converter input length",inBuffer.frameLength); let status = converter.convert(to: outBuffer, error: &convErr) { _, outStatus in
            if consumed { outStatus.pointee = .noDataNow; return nil }
            consumed = true
            outStatus.pointee = .haveData
            return inBuffer
        }
        print("Converter status",status,"outLength",outBuffer.frameLength,"error",String(describing:convErr)); guard status == .haveData || status == .inputRanDry || status == .endOfStream,
              outBuffer.frameLength > 0,
              let ptr = outBuffer.int16ChannelData else { return nil }
        return Data(bytes: ptr[0], count: Int(outBuffer.frameLength) * 2)
    }
}


let format=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:48000,channels:2,interleaved:true)!
let count=960
var data=[Float](repeating:0,count:count*2)
for i in 0..<count {for c in 0..<2 {data[2*i+c]=Float(sin(2*Double.pi*440*Double(i)/48000))*0.5}}
var description:CMAudioFormatDescription?
print("description",CMAudioFormatDescriptionCreate(allocator:kCFAllocatorDefault,asbd:format.streamDescription,layoutSize:0,layout:nil,magicCookieSize:0,magicCookie:nil,extensions:nil,formatDescriptionOut:&description))
var block:CMBlockBuffer?
let len=data.count*4
print("block",CMBlockBufferCreateWithMemoryBlock(allocator:kCFAllocatorDefault,memoryBlock:nil,blockLength:len,blockAllocator:kCFAllocatorDefault,customBlockSource:nil,offsetToData:0,dataLength:len,flags:0,blockBufferOut:&block))
data.withUnsafeBytes {p in print("replace",CMBlockBufferReplaceDataBytes(with:p.baseAddress!,blockBuffer:block!,offsetIntoDestination:0,dataLength:len))}
var sample:CMSampleBuffer?
print("sample",CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator:kCFAllocatorDefault,dataBuffer:block!,formatDescription:description!,sampleCount:count,presentationTimeStamp:.zero,packetDescriptions:nil,sampleBufferOut:&sample))
let box=ConverterBox()
let result=convertSampleBuffer(sample!,converterBox:box)
print("Real CMSampleBuffer path: \(result?.count ?? 0) output bytes; expected near 628")
exit((result?.count ?? 0)>500 ? 0:1)
