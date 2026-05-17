// SplashView.swift
//
// First screen the user sees on cold launch. Brand mark + product name, sized
// large enough to feel like a launch screen (260pt — bumped from 200pt per
// Build 55 final). Auto-dismisses to whatever the parent decides comes next
// (typically SignIn / SignUp).
//
// The splash holds for `displayDuration` so the brand has a moment to land
// before the next screen comes up. We tolerate the user tapping through if
// the parent wires it that way; this view itself is dumb on input.

import SwiftUI

public struct SplashView: View {

    public init(displayDuration: TimeInterval = 1.2, onFinished: @escaping () -> Void = {}) {
        self.displayDuration = displayDuration
        self.onFinished = onFinished
    }

    private let displayDuration: TimeInterval
    private let onFinished: () -> Void

    public var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()

            VStack(spacing: 18) {
                Image(systemName: "bolt.fill")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 260, height: 260)
                    .foregroundStyle(brandGradient)

                Text("ThunderCommo")
                    .font(.largeTitle.bold())
                    .foregroundStyle(brandGradient)
            }
        }
        .task {
            try? await Task.sleep(nanoseconds: UInt64(displayDuration * 1_000_000_000))
            onFinished()
        }
    }

    private var brandGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.66, green: 0.42, blue: 0.98),
                Color(red: 0.92, green: 0.55, blue: 1.0)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}
