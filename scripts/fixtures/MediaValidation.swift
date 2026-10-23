import UIKit
import AVFoundation

// Isolated simulator-only source for media verification. Never part of the product bundle.
@main @MainActor
final class MediaValidation: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var player: AVAudioPlayer?
    private var displayLink: CADisplayLink?
    private let pulse = UIView()
    private let status = UILabel()
    private let button = UIButton(type: .system)

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = "Sim Relay Media Validation"
        title.font = .preferredFont(forTextStyle: .largeTitle)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        title.accessibilityTraits.insert(.header)
        let detail = UILabel()
        detail.text = "Owned test fixture. A quiet 880 Hz pulse repeats once per second. No microphone is used."
        detail.font = .preferredFont(forTextStyle: .body)
        detail.adjustsFontForContentSizeCategory = true
        detail.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .headline)
        status.adjustsFontForContentSizeCategory = true
        status.text = "Pulse off"
        pulse.backgroundColor = .black
        pulse.isAccessibilityElement = false
        button.setTitle("Stop test tone", for: .normal)
        button.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, detail, pulse, status, button])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
            pulse.heightAnchor.constraint(equalToConstant: 120),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller
        self.window = window
        window.makeKeyAndVisible()
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback)
            try AVAudioSession.sharedInstance().setActive(true)
            if let url = Bundle.main.url(forResource: "pulse", withExtension: "wav") {
                player = try AVAudioPlayer(contentsOf: url)
                player?.numberOfLoops = -1
                player?.volume = 0.2
                player?.play()
            }
        } catch { status.text = "Audio unavailable: \(error.localizedDescription)" }
        let link = CADisplayLink(target: self, selector: #selector(updatePulse))
        link.add(to: .main, forMode: .common)
        displayLink = link
        return true
    }
    @objc private func toggle() {
        if player?.isPlaying == true { player?.pause() } else { player?.play() }
        button.setTitle(player?.isPlaying == true ? "Stop test tone" : "Start test tone", for: .normal)
    }
    @objc private func updatePulse() {
        let active = player?.isPlaying == true && (player?.currentTime ?? 1) < 0.1
        if !UIAccessibility.isReduceMotionEnabled { pulse.backgroundColor = active ? .white : .black }
        status.text = UIAccessibility.isReduceMotionEnabled ? "Visual pulse paused for Reduce Motion" : active ? "Pulse on" : "Pulse off"
    }
    func applicationWillTerminate(_ application: UIApplication) {
        displayLink?.invalidate()
        player?.stop()
    }
}
