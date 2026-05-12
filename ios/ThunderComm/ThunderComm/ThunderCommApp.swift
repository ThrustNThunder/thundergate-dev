/**
 * ThunderComm iOS App
 * Sovereign agent communication client.
 *
 * Part of ThrustNThunder/thundergate
 * Built for Boost And Bolt LLC
 *
 * Jon | ThunderBase | 2026-05-05
 */

import SwiftUI

@main
struct ThunderCommApp: App {
    @StateObject private var gateway = GatewayService()
    @AppStorage("gateway_url") private var gatewayURL = ""
    @AppStorage("gateway_token") private var gatewayToken = ""
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(gateway)
                .onAppear {
                    // Auto-connect if configured
                    if !gatewayURL.isEmpty && !gatewayToken.isEmpty,
                       let url = URL(string: gatewayURL) {
                        gateway.configure(url: url, token: gatewayToken)
                        gateway.connect()
                    }
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var gateway: GatewayService
    @State private var selectedTab = 0
    
    var body: some View {
        TabView(selection: $selectedTab) {
            // Chat Tab
            NavigationView {
                ChatView()
            }
            .tabItem {
                Label("Chat", systemImage: "bubble.left.and.bubble.right.fill")
            }
            .tag(0)
            
            // System Events Tab
            NavigationView {
                SystemEventsView()
            }
            .tabItem {
                Label("System", systemImage: "gear.badge")
            }
            .tag(1)
            .badge(gateway.systemEvents.count)
            
            // Settings Tab
            NavigationView {
                SettingsView()
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape.fill")
            }
            .tag(2)
        }
    }
}

// MARK: - System Events View

struct SystemEventsView: View {
    @EnvironmentObject var gateway: GatewayService
    
    var body: some View {
        Group {
            if gateway.systemEvents.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 60))
                        .foregroundColor(.green)
                    
                    Text("No System Events")
                        .font(.headline)
                    
                    Text("Infrastructure notifications will appear here.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            } else {
                List {
                    ForEach(gateway.systemEvents.reversed()) { event in
                        SystemEventRow(event: event)
                    }
                }
            }
        }
        .navigationTitle("System Events")
        .toolbar {
            if !gateway.systemEvents.isEmpty {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Clear") {
                        gateway.systemEvents.removeAll()
                    }
                }
            }
        }
    }
}

struct SystemEventRow: View {
    let event: SystemEventMessage
    
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName)
                .foregroundColor(iconColor)
                .frame(width: 24)
            
            VStack(alignment: .leading, spacing: 4) {
                Text(event.text)
                    .font(.subheadline)
                
                Text(event.date, style: .relative)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
    
    private var iconName: String {
        switch event.category {
        case .github: return "arrow.triangle.branch"
        case .failover: return "exclamationmark.triangle"
        case .scribe: return "doc.text"
        case .gateway: return "network"
        case .beekeeper: return "server.rack"
        }
    }
    
    private var iconColor: Color {
        switch event.category {
        case .github: return .purple
        case .failover: return .orange
        case .scribe: return .blue
        case .gateway: return .green
        case .beekeeper: return .cyan
        }
    }
}

// MARK: - Preview

#Preview {
    ContentView()
        .environmentObject(GatewayService())
}
