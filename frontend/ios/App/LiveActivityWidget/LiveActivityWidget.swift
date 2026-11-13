import SwiftUI

#if canImport(ActivityKit)
import ActivityKit
import AppIntents
import WidgetKit

// ---------------------------------------------------------------------------
// Hex → SwiftUI Color helper
// ---------------------------------------------------------------------------
private extension Color {
    /// Accepts 6-digit hex with or without a leading `#`, e.g. "#1a1a2e" or "1a1a2e".
    init?(hex: String?) {
        guard let hex = hex else { return nil }
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard h.count == 6, let value = UInt64(h, radix: 16) else { return nil }
        self.init(
            red:   Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8)  & 0xFF) / 255,
            blue:  Double( value        & 0xFF) / 255
        )
    }
}

@available(iOS 16.2, *)
@main
struct LiveActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        LiveActivityWidget()
    }
}

@available(iOS 16.2, *)
struct LiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveActivityAttributes.self) { context in
            let bgColor = Color(hex: context.state.backgroundColor) ?? Color.black.opacity(0.75)
            LockScreenView(context: context)
                .activityBackgroundTint(bgColor)
                .activitySystemActionForegroundColor(
                    Color(hex: context.state.textColor) ?? .white
                )
        } dynamicIsland: { context in
            let textCol     = Color(hex: context.state.textColor)     ?? .white
            let progressCol = Color(hex: context.state.progressColor) ?? .white
            let iconCol     = Color(hex: context.state.iconColor)     ?? .white

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if let icon = context.state.icon {
                        Image(systemName: icon).font(.title2).foregroundColor(iconCol)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Timers show their countdown in the center region and an
                    // animating bar in the bottom region, so no ring here — the
                    // native circular timer style always renders its own time
                    // label which can't be hidden and would duplicate the text.
                    if context.state.timerEnd == nil, let progress = context.state.progress {
                        ProgressRing(value: progress, color: progressCol)
                            .frame(width: 36, height: 36)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title).font(.headline).foregroundColor(textCol)
                    if let timerEnd = context.state.timerEnd {
                        Text(timerInterval: Date.now...timerEnd, countsDown: true)
                            .font(.system(.subheadline, design: .monospaced).weight(.medium))
                            .foregroundColor(textCol.opacity(0.9))
                            .monospacedDigit()
                    } else if let subtitle = context.state.subtitle {
                        Text(subtitle).font(.caption).foregroundColor(textCol.opacity(0.8))
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    let barHeight = context.state.progressBarHeight
                    let barRadius = context.state.progressBarRadius
                    VStack(spacing: 8) {
                        if let timerEnd = context.state.timerEnd {
                            let start = context.state.timerStart ?? Date.now
                            StyledLinearProgress(
                                timerRange: start...timerEnd,
                                countsDown: context.state.timerCountsDown ?? true,
                                color: progressCol,
                                height: barHeight,
                                radius: barRadius
                            )
                            .padding(.horizontal)
                        } else if let progress = context.state.progress {
                            StyledLinearProgress(
                                value: progress,
                                color: progressCol,
                                height: barHeight,
                                radius: barRadius
                            )
                            .padding(.horizontal)
                        }
                        ActionButtons(context: context, tint: progressCol, textColor: textCol)
                            .padding(.horizontal)
                    }
                }
            } compactLeading: {
                if let icon = context.state.icon {
                    Image(systemName: icon).foregroundColor(iconCol)
                } else {
                    Circle().fill(iconCol.opacity(0.6)).frame(width: 8, height: 8)
                }
            } compactTrailing: {
                if let timerEnd = context.state.timerEnd {
                    Text(timerInterval: Date.now...timerEnd, countsDown: true)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundColor(textCol)
                        .monospacedDigit()
                        .frame(width: 40)
                } else if let progress = context.state.progress {
                    ProgressRing(value: progress, color: progressCol).frame(width: 20, height: 20)
                }
            } minimal: {
                if let icon = context.state.icon {
                    Image(systemName: icon).foregroundColor(iconCol)
                }
            }
            // Optional colored keyline around the expanded Dynamic Island
            .keylineTint(Color(hex: context.state.keylineTint))
        }
    }
}

// ---------------------------------------------------------------------------
// Styled linear progress bar — honors progressBarHeight / progressBarRadius
// ---------------------------------------------------------------------------
@available(iOS 16.2, *)
private struct StyledLinearProgress: View {
    var value: Double? = nil
    var timerRange: ClosedRange<Date>? = nil
    var countsDown: Bool = true
    let color: Color
    let height: Double?
    let radius: Double?

    // Approximate native linear ProgressView thickness, used to scale to a custom height.
    private let baseHeight: Double = 4

    var body: some View {
        if let range = timerRange {
            // Timer bar — ALWAYS use the native auto-animating ProgressView so the
            // fill moves every second on its own. Honor a custom height by scaling.
            // countsDown: true  → starts full, drains right-to-left
            // countsDown: false → starts empty, fills left-to-right
            let h = height ?? baseHeight
            ProgressView(timerInterval: range, countsDown: countsDown)
                .progressViewStyle(.linear)
                .labelsHidden()
                .tint(color)
                .scaleEffect(x: 1, y: h / baseHeight, anchor: .center)
                .frame(height: h)
        } else if let h = height, let v = value {
            // Static progress with custom height → capsule track + fill
            let r = radius ?? (h / 2)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: r)
                        .fill(color.opacity(0.25))
                    RoundedRectangle(cornerRadius: r)
                        .fill(color)
                        .frame(width: geo.size.width * min(max(v, 0), 1))
                }
            }
            .frame(height: h)
        } else if let v = value {
            ProgressView(value: v)
                .progressViewStyle(.linear)
                .tint(color)
        }
    }

    private var fillFraction: Double {
        if let v = value { return min(max(v, 0), 1) }
        if let range = timerRange {
            let total = range.upperBound.timeIntervalSince(range.lowerBound)
            guard total > 0 else { return 0 }
            let elapsed = Date.now.timeIntervalSince(range.lowerBound)
            return min(max(elapsed / total, 0), 1)
        }
        return 0
    }
}

@available(iOS 16.2, *)
private struct LockScreenView: View {
    let context: ActivityViewContext<LiveActivityAttributes>

    var body: some View {
        let textCol     = Color(hex: context.state.textColor)     ?? .white
        let progressCol = Color(hex: context.state.progressColor) ?? .white
        let iconCol     = Color(hex: context.state.iconColor)     ?? .white

        VStack(spacing: 10) {
            HStack(spacing: 12) {
                if let icon = context.state.icon {
                    Image(systemName: icon).font(.title).foregroundColor(iconCol)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.state.title).font(.headline).foregroundColor(textCol)
                    if let subtitle = context.state.subtitle {
                        Text(subtitle).font(.subheadline).foregroundColor(textCol.opacity(0.8))
                    }
                    let barHeight = context.state.progressBarHeight
                    let barRadius = context.state.progressBarRadius
                    if let timerEnd = context.state.timerEnd {
                        let start = context.state.timerStart ?? Date.now
                        HStack(spacing: 8) {
                            Text(timerInterval: Date.now...timerEnd, countsDown: true)
                                .font(.system(.title3, design: .monospaced).weight(.semibold))
                                .foregroundColor(textCol)
                                .monospacedDigit()
                            Spacer()
                        }
                        StyledLinearProgress(
                            timerRange: start...timerEnd,
                            countsDown: context.state.timerCountsDown ?? true,
                            color: progressCol,
                            height: barHeight,
                            radius: barRadius
                        )
                        .padding(.top, 2)
                    } else if let progress = context.state.progress {
                        StyledLinearProgress(
                            value: progress,
                            color: progressCol,
                            height: barHeight,
                            radius: barRadius
                        )
                        .padding(.top, 4)
                    }
                }
                Spacer()
            }
            ActionButtons(context: context, tint: progressCol, textColor: textCol)
        }
        .padding()
    }
}

// ---------------------------------------------------------------------------
// Action buttons (iOS 17+) — each tap runs an App Intent in the app's process,
// which the plugin forwards to JS as `actionPerformed`.
// ---------------------------------------------------------------------------
@available(iOS 16.2, *)
private struct ActionButtons: View {
    let context: ActivityViewContext<LiveActivityAttributes>
    /// Button fill — the activity's `progressColor`, drawn translucent.
    let tint: Color
    /// Label color — the activity's `textColor`, so labels stay as readable as
    /// the title on whatever `backgroundColor` the activity uses.
    let textColor: Color

    var body: some View {
        if #available(iOS 17.0, *) {
            if let actions = context.state.actions, !actions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(actions, id: \.id) { action in
                        if action.opensApp == true {
                            Button(intent: LiveActivityOpenAppActionIntent(
                                activityId: context.activityID, actionId: action.id
                            )) { label(action) }
                        } else {
                            Button(intent: LiveActivityActionIntent(
                                activityId: context.activityID, actionId: action.id
                            )) { label(action) }
                        }
                    }
                }
                // Explicit colors rather than .bordered + .tint: the system
                // style derives the label color from the tint, which loses
                // contrast on dark Lock Screen backgrounds.
                .buttonStyle(.plain)
            }
        }
    }

    private func label(_ action: LiveActivityAction) -> some View {
        Text(action.title)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .foregroundColor(textColor)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Capsule().fill(tint.opacity(0.35)))
    }
}

@available(iOS 16.2, *)
private struct ProgressRing: View {
    let value: Double
    var color: Color = .white
    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.3), lineWidth: 3)
            Circle().trim(from: 0, to: value)
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(Int(value * 100))%").font(.system(size: 7, weight: .bold)).foregroundColor(color)
        }
    }
}

#else

import WidgetKit

@main
struct LiveActivityWidgetBundle: WidgetBundle {
    var body: some Widget {}
}

#endif
