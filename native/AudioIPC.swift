import Foundation
import Darwin
import os

private struct AudioIPCConfiguration: Decodable {
    let version: Int
    let socketPath: String
    let nonce: String
}

private struct AudioWriteState {
    var pending = Data()
    var armed = false
}

/// App launches have no inherited host pipes. A private authenticated socket owns capture.
final class AudioTransport: Sendable {
    let descriptor: Int32
    let isIPC: Bool
    private let writes = OSAllocatedUnfairLock(initialState: AudioWriteState())

    init() {
        descriptor = STDOUT_FILENO
        isIPC = false
        _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        writes.withLock { $0.armed = true }
    }

    private init(descriptor: Int32) {
        self.descriptor = descriptor
        isIPC = true
    }

    deinit {
        if isIPC { Darwin.close(descriptor) }
    }

    static func connect(configurationPath: String) throws -> AudioTransport {
        let file = Darwin.open(configurationPath, O_RDONLY | O_NOFOLLOW)
        guard file >= 0 else { throw failure("Cannot open the private audio owner configuration.") }
        let handle = FileHandle(fileDescriptor: file, closeOnDealloc: true)
        var info = stat()
        guard fstat(file, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0,
              info.st_size > 0, info.st_size <= 4096 else {
            throw failure("The audio owner configuration must be a private regular file.")
        }
        let configuration = try JSONDecoder().decode(AudioIPCConfiguration.self,
                                                      from: handle.readToEnd() ?? Data())
        guard configuration.version == 1, configuration.nonce.utf8.count == 64,
              configuration.nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              configuration.socketPath.hasPrefix("/"), !configuration.socketPath.utf8.contains(0) else {
            throw failure("The audio owner configuration is invalid.")
        }
        var address = sockaddr_un()
        let path = Array(configuration.socketPath.utf8) + [0]
        guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw failure("The private audio socket path is too long.")
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path) }
        let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard socket >= 0 else { throw failure("Cannot create the private audio connection.") }
        var transferred = false
        defer { if !transferred { Darwin.close(socket) } }
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
        setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw failure("The audio owner is no longer available.") }
        let transport = AudioTransport(descriptor: socket)
        transferred = true
        var hello = try JSONSerialization.data(withJSONObject: [
            "version": 1, "nonce": configuration.nonce, "pid": Int(getpid()),
        ])
        hello.append(10)
        try transport.writeAll(hello)
        var acknowledgement: UInt8 = 0
        guard Darwin.recv(socket, &acknowledgement, 1, 0) == 1, acknowledgement == 1 else {
            throw failure("The audio owner did not authorize this capture.")
        }
        return transport
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "SimRelayAudio", code: 2,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func writeAll(_ data: Data) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.send(descriptor, bytes.baseAddress!.advanced(by: offset),
                                          bytes.count - offset, 0)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw Self.failure("The audio owner stopped receiving data.") }
                offset += written
            }
        }
    }

    private func control(_ value: [String: String], arm: Bool = false) throws {
        // Pause the synchronous audio callback before sending a reliable bounded control record.
        let remaining = writes.withLock { state in
            state.armed = false
            let remaining = state.pending
            state.pending.removeAll(keepingCapacity: false)
            return remaining
        }
        let payload = try JSONSerialization.data(withJSONObject: value)
        guard payload.count <= 4096 else { throw Self.failure("Audio status exceeded its limit.") }
        var size = UInt32(payload.count).littleEndian
        var record = Data(repeating: 0, count: 4)
        withUnsafeBytes(of: &size) { record.append(contentsOf: $0) }
        record.append(payload)
        if !remaining.isEmpty { try writeAll(remaining) }
        try writeAll(record)
        if arm { writes.withLock { $0.armed = true } }
    }

    func ready() throws {
        if isIPC { try control(["type": "ready"], arm: true) }
        else { FileHandle.standardError.write(Data("SIM_RELAY_AUDIO_READY\n".utf8)) }
    }

    func failure(_ message: String) {
        if isIPC {
            // Worst-case JSON escaping stays below the control-record bound.
            try? control(["type": "error", "message": String(message.prefix(600))])
        } else {
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
    }

    func packet(_ data: Data) {
        writes.withLock { state in
            guard state.armed else { return }
            // Stream sockets may accept a partial packet. Keep at most its unsent suffix;
            // subsequent PCM is dropped until that suffix drains, preserving framing.
            if !state.pending.isEmpty {
                let written = state.pending.withUnsafeBytes { bytes in
                    Darwin.send(descriptor, bytes.baseAddress, bytes.count, MSG_DONTWAIT)
                }
                guard written > 0 else { return }
                state.pending.removeFirst(written)
                guard state.pending.isEmpty else { return }
            }
            let written = data.withUnsafeBytes { bytes in
                isIPC ? Darwin.send(descriptor, bytes.baseAddress, bytes.count, MSG_DONTWAIT)
                      : Darwin.write(descriptor, bytes.baseAddress, bytes.count)
            }
            if isIPC && written > 0 && written < data.count {
                state.pending = data.subdata(in: written..<data.count)
            }
        }
    }
}

/// Only this actor owns the read source and continuation. EOF cancels even a pending
/// permission request; normal capture gets a bounded graceful stop before process exit.
actor AudioOwnerLifetime {
    private let descriptor: Int32
    private let source: any DispatchSourceRead
    private var running = false
    private var ended = false
    private var continuation: CheckedContinuation<Void, Never>?

    init(descriptor: Int32) {
        self.descriptor = descriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor,
                                                  queue: DispatchQueue(label: "dev.simrelay.audio.owner"))
        self.source = source
        source.setEventHandler { [weak self] in
            // A Dispatch callback has no structured async parent or UI isolation.
            Task.detached { [weak self] in await self?.receive() }
        }
        source.resume()
    }

    private func receive() {
        guard !ended else { return }
        var byte: UInt8 = 0
        let count = Darwin.recv(descriptor, &byte, 1, MSG_DONTWAIT)
        if count < 0 && (errno == EAGAIN || errno == EINTR) { return }
        ended = true
        source.cancel()
        if !running { exit(0) }
        // stopCapture normally finishes first. A stuck SDK stop must not orphan capture.
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { exit(1) }
        continuation?.resume()
        continuation = nil
    }

    func markRunning() { running = true }

    func wait() async {
        await withCheckedContinuation { continuation in
            if ended { continuation.resume() }
            else { self.continuation = continuation }
        }
    }

    func cancel() { source.cancel() }
}
