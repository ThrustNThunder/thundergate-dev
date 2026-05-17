// SplashView.swift
//
// P8 — Launch splash. Sequence:
//   1. Logo + "ThunderCommo" appear instantly on a dark background.
//   2. Hold the logo for at least 3 seconds.
//   3. When the relay is connected AND the 3-second hold has elapsed, the
//      "Connected to ThunderBase" banner animates in from the bottom.
//      Whichever lands later — connection or 3-second mark — is the trigger.
//   4. Banner stays visible 2 seconds, fades out, then onComplete fires and
//      the main UI takes over.
//
// DeliveryCore handles the actual connect under the hood — its scenePhase
// observer in ThunderCommApp fires on .active regardless of which view is on
// screen, so the splash doesn't block the connect from starting.

import SwiftUI

struct SplashView: View {
    @EnvironmentObject private var deliveryCore: DeliveryCore

    let onComplete: () -> Void

    @State private var bannerShown = false
    @State private var bannerVisible = false

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()

            VStack(spacing: 18) {
                Image("SplashLogo")
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 200, height: 200)
                    .accessibilityHidden(true)

                Text("ThunderCommo")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
            }

            VStack {
                Spacer()
                if bannerShown {
                    HStack(spacing: 10) {
                        Image(systemName: "bolt.fill")
                            .foregroundStyle(.yellow)
                        Text("Connected to ThunderBase")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(
                        Capsule().fill(Color.white.opacity(0.08))
                    )
                    .overlay(
                        Capsule().stroke(Color.white.opacity(0.15), lineWidth: 1)
                    )
                    .opacity(bannerVisible ? 1 : 0)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .padding(.bottom, 64)
                }
            }
        }
        .task {
            await runSequence()
        }
    }

    private func runSequence() async {
        let launchedAt = Date()
        let hardCapSeconds: TimeInterval = 10

        // Minimum 3-second logo hold.
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        if Task.isCancelled { return }

        // Wait until the relay reports connected. If already connected the
        // banner shows immediately; otherwise we hold here until it is — but
        // never past the 10-second hard cap. On cap, skip the banner and
        // drop straight to main UI so the user is never stuck on splash.
        while !deliveryCore.isRelayConnected {
            if Date().timeIntervalSince(launchedAt) >= hardCapSeconds {
                onComplete()
                return
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
            if Task.isCancelled { return }
        }

        // Animate banner in.
        withAnimation(.easeOut(duration: 0.45)) {
            bannerShown = true
            bannerVisible = true
        }

        // Stay 2 seconds.
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        if Task.isCancelled { return }

        // Fade out.
        withAnimation(.easeIn(duration: 0.4)) {
            bannerVisible = false
        }
        try? await Task.sleep(nanoseconds: 450_000_000)

        onComplete()
    }
}
