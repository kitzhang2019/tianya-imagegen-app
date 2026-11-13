import Foundation

#if canImport(ActivityKit)
import ActivityKit
#endif

#if canImport(AppIntents)
import AppIntents
#endif

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

/// A button on the Live Activity. Tapping it fires `actionPerformed` in JS.
public struct LiveActivityAction: Codable, Hashable {
    public var id: String
    public var title: String
    /// Bring the app to the foreground when tapped.
    public var opensApp: Bool?

    public init(id: String, title: String, opensApp: Bool? = nil) {
        self.id = id
        self.title = title
        self.opensApp = opensApp
    }
}

// ---------------------------------------------------------------------------
// Generic JSON-driven ActivityAttributes
// ---------------------------------------------------------------------------
// Both the plugin and the companion Widget Extension share this type so they
// can exchange data through the shared App Group without any custom codegen.

@available(iOS 16.2, *)
public struct LiveActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var title: String
        public var subtitle: String?
        public var progress: Double?
        public var icon: String?
        /// When set, the widget renders a live countdown using SwiftUI's
        /// timerInterval — no repeated update() calls needed from JS.
        public var timerEnd: Date?
        /// Start of the timer interval. Used to compute the progress ring fill.
        /// Defaults to the moment start() was called if omitted.
        public var timerStart: Date?
        /// Direction of the timer bar/ring. true = drain (default), false = fill.
        public var timerCountsDown: Bool?
        /// Hex color string for the activity background tint (e.g. "1a1a2e" or "#1a1a2e").
        public var backgroundColor: String?
        /// Hex color string for progress bars, rings and timer bar. Defaults to white.
        public var progressColor: String?
        /// Hex color string for title and subtitle text. Defaults to white.
        public var textColor: String?
        /// Hex color string for the SF Symbol icon. Defaults to white.
        public var iconColor: String?
        /// Hex color string for the expanded Dynamic Island keyline outline.
        public var keylineTint: String?
        /// Thickness in points of the linear progress bar (2–20).
        public var progressBarHeight: Double?
        /// Corner radius in points of the linear progress bar.
        public var progressBarRadius: Double?
        /// Buttons rendered by the widget (iOS 17+). Each tap runs
        /// `LiveActivityActionIntent`, which forwards it to JS.
        public var actions: [LiveActivityAction]?
        public var extras: [String: AnyCodable]

        public init(
            title: String,
            subtitle: String? = nil,
            progress: Double? = nil,
            icon: String? = nil,
            timerEnd: Date? = nil,
            timerStart: Date? = nil,
            timerCountsDown: Bool? = nil,
            backgroundColor: String? = nil,
            progressColor: String? = nil,
            textColor: String? = nil,
            iconColor: String? = nil,
            keylineTint: String? = nil,
            progressBarHeight: Double? = nil,
            progressBarRadius: Double? = nil,
            actions: [LiveActivityAction]? = nil,
            extras: [String: AnyCodable] = [:]
        ) {
            self.title = title
            self.subtitle = subtitle
            self.progress = progress
            self.icon = icon
            self.timerEnd = timerEnd
            self.timerStart = timerStart
            self.timerCountsDown = timerCountsDown
            self.backgroundColor = backgroundColor
            self.progressColor = progressColor
            self.textColor = textColor
            self.iconColor = iconColor
            self.keylineTint = keylineTint
            self.progressBarHeight = progressBarHeight
            self.progressBarRadius = progressBarRadius
            self.actions = actions
            self.extras = extras
        }
    }

    public var activityType: String
    public var staticData: [String: AnyCodable]

    public init(activityType: String, staticData: [String: AnyCodable] = [:]) {
        self.activityType = activityType
        self.staticData = staticData
    }
}

// ---------------------------------------------------------------------------
// AnyCodable — lightweight wrapper so we can store arbitrary JSON in Codable
// ---------------------------------------------------------------------------

public struct AnyCodable: Codable, Hashable {
    public let value: Any

    public init(_ value: Any) { self.value = value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(Bool.self)   { value = v; return }
        if let v = try? container.decode(Int.self)    { value = v; return }
        if let v = try? container.decode(Double.self) { value = v; return }
        if let v = try? container.decode(String.self) { value = v; return }
        if let v = try? container.decode([String: AnyCodable].self) { value = v; return }
        if let v = try? container.decode([AnyCodable].self) { value = v; return }
        value = NSNull()
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as Bool:                    try container.encode(v)
        case let v as Int:                     try container.encode(v)
        case let v as Double:                  try container.encode(v)
        case let v as String:                  try container.encode(v)
        case let v as [String: AnyCodable]:    try container.encode(v)
        case let v as [AnyCodable]:            try container.encode(v)
        default:                               try container.encodeNil()
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Simple equality for Hashable conformance
        "\(lhs.value)" == "\(rhs.value)"
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine("\(value)")
    }
}

// ---------------------------------------------------------------------------
// LiveActivityManager
// ---------------------------------------------------------------------------

@available(iOS 16.2, *)
public class LiveActivityManager {

    static let shared = LiveActivityManager()
    private init() {}

    // activityId → Activity<LiveActivityAttributes>
    private var activities: [String: Activity<LiveActivityAttributes>] = [:]

    // Latest push-to-start token (iOS 17.2+), cached as it rotates.
    private var pushToStartToken: String?
    private var isObservingPushToStart = false

    // MARK: - isSupported

    func isSupported() -> Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // MARK: - Push-to-start token (iOS 17.2+)

    /// Begins observing the type-level push-to-start token. Call once at app
    /// launch. The token lets your server START a Live Activity remotely,
    /// without the app having called `start()` first.
    func startObservingPushToStartToken() {
        guard !isObservingPushToStart else { return }
        isObservingPushToStart = true

        if #available(iOS 17.2, *) {
            Task {
                for await tokenData in Activity<LiveActivityAttributes>.pushToStartTokenUpdates {
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    self.pushToStartToken = token
                    NotificationCenter.default.post(
                        name: .liveActivityPushToStartTokenUpdated,
                        object: nil,
                        userInfo: ["token": token, "type": "apns"]
                    )
                }
            }
        }
    }

    /// Returns the latest cached push-to-start token, or nil if not yet issued
    /// or unsupported (< iOS 17.2). Listen to `pushToStartTokenUpdated` for the
    /// value as soon as the system issues it.
    func getPushToStartToken() -> String? {
        pushToStartToken
    }

    // MARK: - areActivitiesEnabled

    func areActivitiesEnabled() -> Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // MARK: - start

    func start(
        attributes: [String: Any],
        state: [String: Any],
        staleAfterSeconds: Double?
    ) throws -> String {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw LiveActivityError.activitiesDisabled
        }

        let activityType = attributes["activityType"] as? String ?? "unknown"
        var staticData: [String: AnyCodable] = [:]
        for (k, v) in attributes where k != "activityType" {
            staticData[k] = AnyCodable(v)
        }

        let contentState = try buildContentState(from: state)
        let activityAttributes = LiveActivityAttributes(
            activityType: activityType,
            staticData: staticData
        )

        var staleDate: Date? = nil
        if let seconds = staleAfterSeconds, seconds > 0 {
            staleDate = Date().addingTimeInterval(seconds)
        }

        let activity = try Activity<LiveActivityAttributes>.request(
            attributes: activityAttributes,
            contentState: contentState,
            pushType: nil
        )

        let activityId = activity.id
        activities[activityId] = activity

        // Observe state changes and forward them as Capacitor events
        Task {
            for await stateUpdate in activity.activityStateUpdates {
                NotificationCenter.default.post(
                    name: .liveActivityStateChanged,
                    object: nil,
                    userInfo: [
                        "activityId": activityId,
                        "activityState": stateUpdate.rawStateString
                    ]
                )
            }
        }

        // Observe push token changes (issued on first request, may rotate)
        Task {
            for await tokenData in activity.pushTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                NotificationCenter.default.post(
                    name: .liveActivityPushTokenUpdated,
                    object: nil,
                    userInfo: [
                        "activityId": activityId,
                        "token": token,
                        "type": "apns"
                    ]
                )
            }
        }

        return activityId
    }

    // MARK: - update

    func update(
        activityId: String,
        state: [String: Any],
        alertTitle: String?,
        alertBody: String?
    ) async throws {
        guard let activity = activity(for: activityId) else {
            throw LiveActivityError.activityNotFound(activityId)
        }

        let contentState = try buildContentState(from: state)
        var alertConfig: AlertConfiguration? = nil

        if let title = alertTitle, let body = alertBody {
            alertConfig = AlertConfiguration(
                title: LocalizedStringResource(stringLiteral: title),
                body: LocalizedStringResource(stringLiteral: body),
                sound: .default
            )
        }

        await activity.update(
            ActivityContent(
                state: contentState,
                staleDate: nil
            ),
            alertConfiguration: alertConfig
        )
    }

    // MARK: - end

    func end(
        activityId: String,
        finalState: [String: Any]?,
        dismissalPolicy: String?
    ) async throws {
        guard let activity = activity(for: activityId) else {
            throw LiveActivityError.activityNotFound(activityId)
        }

        let policy: ActivityUIDismissalPolicy
        switch dismissalPolicy {
        case "immediate":    policy = .immediate
        case "after-delay":  policy = .after(.now + 30)
        default:             policy = .default
        }

        if let stateDict = finalState {
            let contentState = try buildContentState(from: stateDict)
            await activity.end(
                ActivityContent(state: contentState, staleDate: nil),
                dismissalPolicy: policy
            )
        } else {
            await activity.end(dismissalPolicy: policy)
        }

        activities.removeValue(forKey: activityId)
    }

    // MARK: - getPushToken

    func getPushToken(activityId: String) -> String? {
        guard let activity = activity(for: activityId) else { return nil }
        guard let tokenData = activity.pushToken else { return nil }
        return tokenData.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - getActiveActivities

    func getActiveActivities() -> [[String: String]] {
        Activity<LiveActivityAttributes>.activities.map { activity in
            [
                "activityId": activity.id,
                "activityType": activity.attributes.activityType,
                "state": activity.activityState.rawStateString
            ]
        }
    }

    // MARK: - Helpers

    /// Activities started in this process, or — after a relaunch, e.g. when an
    /// action-button tap is delivered on the next launch — still running ones
    /// looked up from ActivityKit.
    private func activity(for activityId: String) -> Activity<LiveActivityAttributes>? {
        if let activity = activities[activityId] { return activity }
        guard let activity = Activity<LiveActivityAttributes>.activities.first(where: { $0.id == activityId }) else {
            return nil
        }
        activities[activityId] = activity
        return activity
    }

    private func buildContentState(from dict: [String: Any]) throws -> LiveActivityAttributes.ContentState {
        guard let title = dict["title"] as? String else {
            throw LiveActivityError.missingField("title")
        }

        var extras: [String: AnyCodable] = [:]
        let reserved: Set<String> = [
            "title", "subtitle", "progress", "icon",
            "timerEnd", "timerStart", "timerCountsDown",
            "backgroundColor", "progressColor", "textColor", "iconColor",
            "keylineTint", "progressBarHeight", "progressBarRadius", "actions"
        ]
        for (k, v) in dict where !reserved.contains(k) {
            extras[k] = AnyCodable(v)
        }

        // Accept timerEnd / timerStart as Unix timestamps (seconds since epoch)
        var timerEnd: Date? = nil
        var timerStart: Date? = nil
        if let ts = dict["timerEnd"] as? Double { timerEnd = Date(timeIntervalSince1970: ts) }
        if let ts = dict["timerStart"] as? Double { timerStart = Date(timeIntervalSince1970: ts) }

        let actions: [LiveActivityAction]? = (dict["actions"] as? [[String: Any]])?.compactMap { item in
            guard let id = item["id"] as? String, let title = item["title"] as? String else { return nil }
            return LiveActivityAction(id: id, title: title, opensApp: item["opensApp"] as? Bool)
        }

        return LiveActivityAttributes.ContentState(
            title: title,
            subtitle: dict["subtitle"] as? String,
            progress: dict["progress"] as? Double,
            icon: dict["icon"] as? String,
            timerEnd: timerEnd,
            timerStart: timerStart,
            timerCountsDown: dict["timerCountsDown"] as? Bool,
            backgroundColor: dict["backgroundColor"] as? String,
            progressColor: dict["progressColor"] as? String,
            textColor: dict["textColor"] as? String,
            iconColor: dict["iconColor"] as? String,
            keylineTint: dict["keylineTint"] as? String,
            progressBarHeight: dict["progressBarHeight"] as? Double,
            progressBarRadius: dict["progressBarRadius"] as? Double,
            actions: actions,
            extras: extras
        )
    }
}

// MARK: - Helpers on ActivityState

@available(iOS 16.2, *)
private extension ActivityState {
    var rawStateString: String {
        switch self {
        case .active:    return "active"
        case .ended:     return "ended"
        case .dismissed: return "dismissed"
        @unknown default: return "active"
        }
    }
}

// MARK: - Notification name

extension Notification.Name {
    static let liveActivityStateChanged    = Notification.Name("LiveActivityStateChanged")
    static let liveActivityPushTokenUpdated = Notification.Name("LiveActivityPushTokenUpdated")
    static let liveActivityPushToStartTokenUpdated = Notification.Name("LiveActivityPushToStartTokenUpdated")
    static let liveActivityActionPerformed = Notification.Name("LiveActivityActionPerformed")
    /// Posted by the plugin after `update()` / `end()` for an activity, so a
    /// running action intent knows the app has reacted to the tap.
    static let liveActivityActionHandled = Notification.Name("LiveActivityActionHandled")
}

// ---------------------------------------------------------------------------
// Action button taps → plugin
// ---------------------------------------------------------------------------
// A tap can start the app in the background before the plugin (or the
// WebView) is loaded, so taps are queued in UserDefaults and the plugin drains
// the queue when it loads and whenever it is notified.

public enum LiveActivityActionQueue {
    static let defaultsKey = "CapacitorLiveActivities.pendingActions"

    public static func enqueue(activityId: String, actionId: String) {
        let defaults = UserDefaults.standard
        var pending = defaults.array(forKey: defaultsKey) as? [[String: String]] ?? []
        pending.append(["activityId": activityId, "actionId": actionId])
        defaults.set(pending, forKey: defaultsKey)
        NotificationCenter.default.post(name: .liveActivityActionPerformed, object: nil)
    }

    /// Waits until the app responds to the tap with `update()` / `end()` for
    /// this activity, or until `timeout`. iOS keeps the app running while an
    /// intent's `perform()` is in progress, which gives the WebView time to run
    /// the JS `actionPerformed` handler even when the app is in the background.
    @available(iOS 15.0, *)
    public static func waitUntilHandled(activityId: String, timeout: TimeInterval) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                for await note in NotificationCenter.default.notifications(named: .liveActivityActionHandled) {
                    if (note.userInfo?["activityId"] as? String) == activityId { return }
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            }
            await group.next()
            group.cancelAll()
        }
    }

    static func drain() -> [[String: String]] {
        let defaults = UserDefaults.standard
        let pending = defaults.array(forKey: defaultsKey) as? [[String: String]] ?? []
        defaults.removeObject(forKey: defaultsKey)
        return pending
    }
}

#if canImport(AppIntents) && canImport(ActivityKit)
/// Runs when a Live Activity button is tapped (iOS 17+).
///
/// This file must be a member of BOTH the app target and the Widget Extension
/// target: the widget uses the type to build `Button(intent:)`, and because it
/// is a `LiveActivityIntent` that also exists in the app, the system runs
/// `perform()` in the app's process — where the plugin can see the tap.
@available(iOS 17.0, *)
public struct LiveActivityActionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Live Activity action"
    public static var isDiscoverable: Bool = false

    @Parameter(title: "Activity ID")
    public var activityId: String

    @Parameter(title: "Action ID")
    public var actionId: String

    public init() {}

    public init(activityId: String, actionId: String) {
        self.activityId = activityId
        self.actionId = actionId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        LiveActivityActionQueue.enqueue(activityId: activityId, actionId: actionId)
        // Keep the app awake until JS reacts (or 10 s pass). If the app was not
        // running, the tap stays queued and is delivered on the next launch.
        await LiveActivityActionQueue.waitUntilHandled(activityId: activityId, timeout: 10)
        return .result()
    }
}

/// Same as `LiveActivityActionIntent`, but brings the app to the foreground.
@available(iOS 17.0, *)
public struct LiveActivityOpenAppActionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Open app for Live Activity action"
    public static var isDiscoverable: Bool = false
    public static var openAppWhenRun: Bool = true

    @Parameter(title: "Activity ID")
    public var activityId: String

    @Parameter(title: "Action ID")
    public var actionId: String

    public init() {}

    public init(activityId: String, actionId: String) {
        self.activityId = activityId
        self.actionId = actionId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        LiveActivityActionQueue.enqueue(activityId: activityId, actionId: actionId)
        return .result()
    }
}
#endif

// MARK: - Errors

enum LiveActivityError: LocalizedError {
    case activitiesDisabled
    case activityNotFound(String)
    case missingField(String)

    var errorDescription: String? {
        switch self {
        case .activitiesDisabled:        return "Live Activities are disabled for this app."
        case .activityNotFound(let id):  return "No active Live Activity found with id: \(id)"
        case .missingField(let field):   return "Required field missing from state: \(field)"
        }
    }
}
