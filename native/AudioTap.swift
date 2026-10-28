import Foundation
import CoreAudio
import AudioToolbox
import Dispatch
import os

// Host-wide output capture; this does not isolate individual simulators. The app
// must provide NSAudioCaptureUsageDescription and obtain the user's approval.
// https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
@available(macOS 14.2, *)
final class CoreAudioTapCapture {
    private let transport: AudioTransport
    private let ioQueue = DispatchQueue(label: "dev.simrelay.audio.tap.io", qos: .userInteractive)
    private let statusQueue = DispatchQueue(label: "dev.simrelay.audio.tap.status")
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var startAttempted = false
    private var processor: TapPCMProcessor?
    private var listeners: [TapFormatListener] = []
    private var statusTimer: (any DispatchSourceTimer)?

    private init(transport: AudioTransport) { self.transport = transport }

    /// Synchronous HAL startup can request permission. Keep this object local to
    /// the parent's capture function; only its checked-Sendable processor escapes.
    /// The parent calls transport.ready() after this returns, and owns shutdown.
    static func start(transport: AudioTransport) throws -> Self {
        let capture = Self(transport: transport)
        do {
            try capture.configure()
            return capture
        } catch {
            let startupError = error
            do { try capture.close() }
            catch {
                throw tapError("\(startupError.localizedDescription) Cleanup also failed: \(error.localizedDescription)")
            }
            throw startupError
        }
    }

    private func configure() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "SimRelayAudio"
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try tapCheck(AudioHardwareCreateProcessTap(description, &tap), "create the system audio tap")
        guard tap != kAudioObjectUnknown else { throw tapError("Core Audio returned no system audio tap.") }

        let format = try TapPCMFormat(readTapFormat())
        let tapUID = try readTapUID()
        let configuration: [String: Any] = [
            kAudioAggregateDeviceNameKey: "SimRelayAudio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        // Intentionally no physical subdevices, default-device writes, or global
        // volume/sample-rate changes: the aggregate contains only our private tap.
        try tapCheck(AudioHardwareCreateAggregateDevice(configuration as CFDictionary, &aggregate),
                     "create the private tap-only aggregate")
        guard aggregate != kAudioObjectUnknown else { throw tapError("Core Audio returned no tap aggregate device.") }

        let processor = TapPCMProcessor(format: format, transport: transport)
        self.processor = processor
        try addFormatListener(object: tap, selector: kAudioTapPropertyFormat,
                              scope: kAudioObjectPropertyScopeGlobal, processor: processor)
        try addFormatListener(object: aggregate, selector: kAudioDevicePropertyStreamFormat,
                              scope: kAudioObjectPropertyScopeInput, processor: processor)

        // Check again after registering listeners, closing the startup race. The
        // tap's ASBD describes its samples in the aggregate; verify the aggregate
        // agrees before interpreting its IO buffers with that format.
        guard try TapPCMFormat(readTapFormat()) == format,
              try TapPCMFormat(readAggregateFormat()) == format else {
            throw tapError("The system audio format changed during startup. Restart audio capture after selecting a stable output device.")
        }
        try tapCheck(AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, ioQueue) {
            [processor] _, input, inputTime, _, _ in
            let timestamp = inputTime.pointee
            let sampleTime: Double? = timestamp.mFlags.contains(.sampleTimeValid)
                && timestamp.mSampleTime.isFinite ? timestamp.mSampleTime : nil
            processor.consume(input, sampleTime: sampleTime)
        }, "register the tap IOProc")
        guard let ioProc else { throw tapError("Core Audio returned no tap IOProc.") }
        startAttempted = true
        try tapCheck(AudioDeviceStart(aggregate, ioProc), "start system audio capture (approve Sim Relay Audio in System Settings if requested)")
        if let fault = processor.startupFault() { throw tapError(fault) }

        // Faults are recorded in the callback, but reliable IPC error records can
        // block. A coalescing timer reports at most once, off the IO queue; no
        // callback dispatches work or builds an unbounded queue of audio/errors.
        let timer = DispatchSource.makeTimerSource(queue: statusQueue)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [processor] in processor.reportFault() }
        statusTimer = timer
        timer.resume()
    }

    private func readTapFormat() throws -> AudioStreamBasicDescription {
        try readFormat(object: tap, selector: kAudioTapPropertyFormat, scope: kAudioObjectPropertyScopeGlobal)
    }

    private func readAggregateFormat() throws -> AudioStreamBasicDescription {
        try readFormat(object: aggregate, selector: kAudioDevicePropertyStreamFormat, scope: kAudioObjectPropertyScopeInput)
    }

    private func readFormat(object: AudioObjectID, selector: AudioObjectPropertySelector,
                            scope: AudioObjectPropertyScope) throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                                                 mElement: kAudioObjectPropertyElementMain)
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try tapCheck(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &format),
                     "read the audio format of object \(object)")
        guard size == UInt32(MemoryLayout<AudioStreamBasicDescription>.size) else {
            throw tapError("Core Audio returned an incomplete audio format for object \(object). Restart audio capture.")
        }
        return format
    }

    private func readTapUID() throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyUID,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var uid: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &uid) {
            AudioObjectGetPropertyData(tap, &address, 0, nil, &size, $0)
        }
        try tapCheck(status, "read the system audio tap UID")
        guard size == UInt32(MemoryLayout<CFString>.size), !(uid as String).isEmpty else {
            throw tapError("Core Audio returned an empty system audio tap UID. Restart audio capture.")
        }
        return uid as String
    }

    private func addFormatListener(object: AudioObjectID, selector: AudioObjectPropertySelector,
                                   scope: AudioObjectPropertyScope, processor: TapPCMProcessor) throws {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                                                 mElement: kAudioObjectPropertyElementMain)
        // A synchronous property listener invalidates interpretation immediately;
        // it never queries HAL, writes IPC, or captures the non-Sendable owner.
        let block: AudioObjectPropertyListenerBlock = { [processor] _, _ in
            processor.invalidateFormat()
        }
        try tapCheck(AudioObjectAddPropertyListenerBlock(object, &address, nil, block),
                     "observe audio format changes on object \(object)")
        listeners.append(TapFormatListener(object: object, address: address, block: block))
    }

    /// Idempotent after success. Attempts every owned-resource teardown even if
    /// an earlier operation fails, and retains failed resources for a retry.
    /// Call from the same local owner as start(), never from an IO callback.
    func close() throws {
        processor?.stop()
        statusTimer?.cancel()
        statusTimer = nil
        var errors: [String] = []
        func record(_ status: OSStatus, _ operation: String) -> Bool {
            guard status != noErr else { return true }
            errors.append(tapStatusMessage(status, operation))
            return false
        }
        if startAttempted, aggregate != kAudioObjectUnknown {
            if record(AudioDeviceStop(aggregate, ioProc), "stop the tap aggregate") { startAttempted = false }
        }
        if let ioProc, aggregate != kAudioObjectUnknown {
            if record(AudioDeviceDestroyIOProcID(aggregate, ioProc), "destroy the tap IOProc") {
                self.ioProc = nil
                startAttempted = false
            }
        }
        var remainingListeners: [TapFormatListener] = []
        for var listener in listeners {
            if !record(AudioObjectRemovePropertyListenerBlock(listener.object, &listener.address, nil, listener.block),
                       "remove the format listener from object \(listener.object)") {
                remainingListeners.append(listener)
            }
        }
        listeners = remainingListeners
        if aggregate != kAudioObjectUnknown {
            let destroyedID = aggregate
            if record(AudioHardwareDestroyAggregateDevice(aggregate), "destroy the private tap aggregate") {
                aggregate = AudioObjectID(kAudioObjectUnknown)
                ioProc = nil
                startAttempted = false
                listeners.removeAll { $0.object == destroyedID }
            }
        }
        if tap != kAudioObjectUnknown {
            let destroyedID = tap
            if record(AudioHardwareDestroyProcessTap(tap), "destroy the system audio tap") {
                tap = AudioObjectID(kAudioObjectUnknown)
                listeners.removeAll { $0.object == destroyedID }
            }
        }
        if !errors.isEmpty { throw tapError(errors.joined(separator: "; ")) }
    }

    deinit {
        do { try close() }
        catch { transport.failure("System audio cleanup failed: \(error.localizedDescription)") }
    }
}

@available(macOS 14.2, *)
private struct TapFormatListener {
    let object: AudioObjectID
    var address: AudioObjectPropertyAddress
    let block: AudioObjectPropertyListenerBlock
}

private func tapError(_ message: String) -> NSError {
    NSError(domain: "SimRelayAudioTap", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private func tapStatusMessage(_ status: OSStatus, _ operation: String) -> String {
    let bits = UInt32(bitPattern: status)
    let bytes = [UInt8(truncatingIfNeeded: bits >> 24), UInt8(truncatingIfNeeded: bits >> 16),
                 UInt8(truncatingIfNeeded: bits >> 8), UInt8(truncatingIfNeeded: bits)]
    let fourCC = bytes.allSatisfy { (32...126).contains($0) }
        ? " ('\(String(decoding: bytes, as: UTF8.self))')" : ""
    return "Cannot \(operation): Core Audio OSStatus \(status)\(fourCC). Check system audio recording permission for Sim Relay Audio and the selected audio output, then restart capture."
}

private func tapCheck(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw tapError(tapStatusMessage(status, operation)) }
}

// Copy only primitive format fields into the Sendable processor, not SDK objects.
private struct TapPCMFormat: Sendable, Equatable {
    let sampleRate: Double
    let planar: Bool
    let bytesPerFrame: Int

    init(_ format: AudioStreamBasicDescription) throws {
        let planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let stride = planar ? 4 : 8
        let allowedFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
              format.mFormatFlags & ~allowedFlags == 0,
              format.mBitsPerChannel == 32, format.mChannelsPerFrame == 2,
              format.mBytesPerFrame == UInt32(stride), format.mFramesPerPacket == 1,
              format.mBytesPerPacket == UInt32(stride),
              format.mSampleRate.isFinite, (8000...192000).contains(format.mSampleRate) else {
            throw tapError("Unsupported system audio tap format: expected packed native-endian float32 stereo PCM at 8–192 kHz (planar or interleaved); received format \(format.mFormatID), flags \(format.mFormatFlags), \(format.mSampleRate) Hz, \(format.mChannelsPerFrame) channels, \(format.mBitsPerChannel) bits, \(format.mBytesPerFrame) bytes/frame. Select a supported output and restart capture.")
        }
        self.sampleRate = format.mSampleRate
        self.planar = planar
        self.bytesPerFrame = stride
    }
}

private enum TapPCMFault: Sendable {
    case formatChanged
    case invalidBuffers
    case oversizedBuffer

    var message: String {
        switch self {
        case .formatChanged:
            "The system audio format changed. Restart audio capture after selecting the desired output device."
        case .invalidBuffers:
            "The system audio tap delivered a buffer layout inconsistent with its float32 stereo format. Restart audio capture after selecting a supported output device."
        case .oversizedBuffer:
            "The system audio tap exceeded the 4096-frame callback limit. Select an output with a smaller audio buffer and restart capture."
        }
    }
}

private struct TapPCMStream: Sendable {
    var hasPrevious = false
    var previousLeft: Float = 0
    var previousRight: Float = 0
    // Position relative to the previous input sample, in units of 1/48000
    // input frames. Bounded by max(48000, inputRate), independent of duration.
    // Integer-Hz rates accumulate exactly, including 44100 -> 48000.
    var nextPosition: Double = 0
    var expectedSampleTime: Double?

    mutating func reset() {
        hasPrevious = false
        nextPosition = 0
        expectedSampleTime = nil
    }
}

private struct TapPCMState: Sendable {
    var stopped = false
    var fault: TapPCMFault?
    var reported = false
    var stream = TapPCMStream()
    // One reusable 384-byte PCM payload and its u32LE length header.
    var packet = Data(repeating: 0, count: 388)
}

private final class TapPCMProcessor: Sendable {
    private let format: TapPCMFormat
    private let transport: AudioTransport
    private let state = OSAllocatedUnfairLock(initialState: TapPCMState())

    init(format: TapPCMFormat, transport: AudioTransport) {
        self.format = format
        self.transport = transport
    }

    func invalidateFormat() {
        state.withLock { state in
            if !state.stopped, state.fault == nil { state.fault = .formatChanged }
        }
    }

    func stop() { state.withLock { $0.stopped = true } }

    func startupFault() -> String? { state.withLock { $0.fault?.message } }

    func reportFault() {
        let fault = state.withLock { state -> TapPCMFault? in
            guard !state.stopped, !state.reported, let fault = state.fault else { return nil }
            state.reported = true
            return fault
        }
        if let fault { transport.failure(fault.message) }
    }

    func consume(_ input: UnsafePointer<AudioBufferList>, sampleTime: Double?) {
        // The Unchecked accessor only removes @Sendable from this synchronous,
        // nonescaping borrow of HAL-owned pointers. No pointer escapes this call
        // or receives a Sendable conformance. If shutdown/status holds the lock,
        // drop this callback rather than waiting on that thread.
        _ = state.withLockIfAvailableUnchecked { state in
            guard !state.stopped, state.fault == nil else { return }
            let count = format.planar ? 2 : 1
            guard input.pointee.mNumberBuffers == UInt32(count) else {
                state.fault = .invalidBuffers
                return
            }
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            let first = buffers[0]
            guard first.mNumberChannels == (format.planar ? 1 : 2),
                  first.mDataByteSize % UInt32(format.bytesPerFrame) == 0 else {
                state.fault = .invalidBuffers
                return
            }
            let frames = Int(first.mDataByteSize) / format.bytesPerFrame
            guard frames <= 4096 else {
                state.fault = .oversizedBuffer
                return
            }
            if format.planar {
                guard buffers[1].mNumberChannels == 1,
                      buffers[1].mDataByteSize == first.mDataByteSize else {
                    state.fault = .invalidBuffers
                    return
                }
            }
            guard frames > 0 else { return }
            // HAL may supply null data for a disabled input stream. Do not join
            // samples across that gap, and never dereference the null pointer.
            guard let left = first.mData,
                  let right = (format.planar ? buffers[1].mData : first.mData) else {
                state.stream.reset()
                return
            }
            var stream = state.stream
            if let sampleTime, let expected = stream.expectedSampleTime,
               abs(sampleTime - expected) > 0.5 { stream.reset() }
            stream.expectedSampleTime = sampleTime.map { $0 + Double(frames) }
            // Mutate a small local stream value while borrowing only the packet
            // field; this avoids overlapping Swift inout accesses/COW copies.
            state.packet.withUnsafeMutableBytes { (packet: UnsafeMutableRawBufferPointer) in
                var payload = 0
                for frame in 0..<frames {
                    let offset = frame * format.bytesPerFrame
                    let l = Self.sanitize(left.loadUnaligned(fromByteOffset: offset, as: Float.self))
                    let r = Self.sanitize(right.loadUnaligned(fromByteOffset: offset + (format.planar ? 0 : 4), as: Float.self))
                    if stream.hasPrevious {
                        // Emit the half-open interval [previous, current). The
                        // last input sample waits for its successor, including
                        // across callbacks; phase is never rounded per buffer.
                        while stream.nextPosition < 48000 {
                            let fraction = Float(stream.nextPosition / 48000)
                            let outLeft = stream.previousLeft + (l - stream.previousLeft) * fraction
                            let outRight = stream.previousRight + (r - stream.previousRight) * fraction
                            Self.storePCM(outLeft, into: packet, offset: 4 + payload)
                            Self.storePCM(outRight, into: packet, offset: 6 + payload)
                            payload += 4
                            if payload == 384 {
                                send(packet, payload: payload)
                                payload = 0
                            }
                            stream.nextPosition += format.sampleRate
                        }
                        stream.nextPosition -= 48000
                    } else {
                        stream.hasPrevious = true
                    }
                    stream.previousLeft = l
                    stream.previousRight = r
                }
                if payload > 0 { send(packet, payload: payload) }
            }
            state.stream = stream
        }
    }

    private static func sanitize(_ sample: Float) -> Float {
        sample.isFinite ? max(-1, min(1, sample)) : 0
    }

    private static func storePCM(_ sample: Float, into bytes: UnsafeMutableRawBufferPointer, offset: Int) {
        let scaled = sample < 0 ? sample * 32768 : sample * 32767
        let value = Int16(max(-32768, min(32767, scaled)))
        let bits = UInt16(bitPattern: value)
        bytes[offset] = UInt8(truncatingIfNeeded: bits)
        bytes[offset + 1] = UInt8(truncatingIfNeeded: bits >> 8)
    }

    private func send(_ bytes: UnsafeMutableRawBufferPointer, payload: Int) {
        bytes[0] = UInt8(truncatingIfNeeded: payload)
        bytes[1] = UInt8(truncatingIfNeeded: payload >> 8)
        bytes[2] = 0
        bytes[3] = 0
        // At most 388 bytes allocated per packet, never a callback-sized audio
        // allocation. AudioTransport owns nonblocking writes and bounded drops.
        transport.packet(Data(bytes: bytes.baseAddress!, count: payload + 4))
    }
}
