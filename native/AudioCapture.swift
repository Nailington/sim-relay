import Foundation
import ScreenCaptureKit
import CoreMedia
import AudioToolbox
import Darwin

// One instance per host, explicitly enabled by its owner. stdout is length-prefixed
// 48 kHz stereo signed little-endian PCM16; stderr carries bounded diagnostics.
// SCK calls the output on a serial queue. There is no retained sample backlog.
final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, Sendable {
    private let transport: AudioTransport

    init(transport: AudioTransport) { self.transport = transport }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        transport.failure("Audio capture stopped: \(error.localizedDescription)")
        exit(1)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let format = sampleBuffer.formatDescription,
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              description.mSampleRate == 48000,
              description.mChannelsPerFrame == 2,
              description.mFormatID == kAudioFormatLinearPCM,
              description.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              description.mBitsPerChannel == 32 else { return }
        var required = 0
        var block: CMBlockBuffer?
        let flags = UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment)
        _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &required, bufferListOut: nil,
            bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: flags, blockBufferOut: &block)
        guard required >= MemoryLayout<AudioBufferList>.size, required <= 4096 else { return }
        let storage = UnsafeMutableRawPointer.allocate(byteCount: required, alignment: 16)
        defer { storage.deallocate() }
        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list,
            bufferListSize: required, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: flags, blockBufferOut: &block) == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let planar = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0, frames <= 48000, buffers.count >= (planar ? 2 : 1) else { return }
        var data = Data(capacity: frames * 4)
        for frame in 0..<frames {
            for channel in 0..<2 {
                let buffer = buffers[planar ? channel : 0]
                let index = planar ? frame : frame * 2 + channel
                guard let base = buffer.mData, (index + 1) * 4 <= Int(buffer.mDataByteSize) else { return }
                let sample = base.load(fromByteOffset: index * 4, as: Float.self)
                let finite = sample.isFinite ? sample : 0
                var pcm = Int16(max(-32768, min(32767, finite * 32767))).littleEndian
                withUnsafeBytes(of: &pcm) { data.append(contentsOf: $0) }
            }
        }
        // Writes stay below Darwin PIPE_BUF (512 bytes): drop whole packets on backpressure.
        for offset in stride(from: 0, to: data.count, by: 384) {
            let chunk = data.subdata(in: offset..<min(offset + 384, data.count))
            var size = UInt32(chunk.count).littleEndian
            var output = Data(bytes: &size, count: 4)
            output.append(chunk)
            transport.packet(output)
        }
    }
}

@main
struct AudioCapture {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        var transport: AudioTransport?
        do {
            if CommandLine.arguments.contains("--probe") {
                print("screencapturekit-pcm16-48000-stereo-v1")
                return
            }
            if let option = CommandLine.arguments.firstIndex(of: "--ipc-config") {
                guard option + 1 < CommandLine.arguments.count else {
                    throw NSError(domain: "SimRelayAudio", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "Missing audio owner configuration."])
                }
                transport = try AudioTransport.connect(configurationPath: CommandLine.arguments[option + 1])
            } else { transport = AudioTransport() }
            try await capture(transport!)
        } catch {
            let message = "Cannot capture Mac audio. Allow Screen & System Audio Recording for Sim Relay Audio in System Settings, then retry. \(error.localizedDescription)"
            if let transport { transport.failure(message) }
            else { FileHandle.standardError.write(Data((message + "\n").utf8)) }
            exit(1)
        }
    }

    // Async main is implicitly MainActor-isolated. Older SDKs do not mark SCK's
    // snapshots Sendable, so consume and release them here, without actor hops.
    // Only Void crosses back to main; no SDK type gains an unsafe conformance.
    #if compiler(>=6.2)
    @concurrent
    #endif
    private nonisolated static func capture(_ transport: AudioTransport) async throws {
        let owner = transport.isIPC ? AudioOwnerLifetime(descriptor: transport.descriptor) : nil
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                throw NSError(domain: "SimRelayAudio", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Log into the Mac desktop and attach a display before enabling audio."])
            }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.queueDepth = 3
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48000
            configuration.channelCount = 2
            let output = AudioOutput(transport: transport)
            let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
            try stream.addStreamOutput(output, type: .audio,
                                       sampleHandlerQueue: DispatchQueue(label: "dev.simrelay.audio.samples"))
            try await stream.startCapture()
            try transport.ready()
            await owner?.markRunning()
            // EOF is host ownership loss, including host crashes.
            if let owner { await owner.wait() }
            else {
                let input = FileHandle.standardInput
                for try await _ in input.bytes { }
            }
            try await stream.stopCapture()
            await owner?.cancel()
        } catch {
            await owner?.cancel()
            throw error
        }
    }
}
