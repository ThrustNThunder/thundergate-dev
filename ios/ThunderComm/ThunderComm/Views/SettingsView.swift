/**
 * ThunderComm Settings View
 * Gateway configuration and connection management.
 *
 * Jon | ThunderBase | 2026-05-05
 */

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var gateway: GatewayService
    @AppStorage("gateway_url") private var gatewayURL = ""
    @AppStorage("gateway_token") private var gatewayToken = ""
    @State private var showingQRScanner = false
    @State private var isEditing = false
    
    var body: some View {
        Form {
            // Connection Status
            Section {
                HStack {
                    Text("Status")
                    Spacer()
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 10, height: 10)
                        Text(gateway.connectionStatus.displayText)
                            .foregroundColor(.secondary)
                    }
                }
                
                if gateway.connectionStatus == .connected {
                    HStack {
                        Text("Agents Online")
                        Spacer()
                        Text("\(gateway.agents.filter { $0.status == .online }.count)")
                            .foregroundColor(.secondary)
                    }
                }
            } header: {
                Text("Connection")
            }
            
            // Gateway Configuration
            Section {
                if isEditing {
                    TextField("Gateway URL", text: $gatewayURL)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                    
                    SecureField("Token", text: $gatewayToken)
                        .textContentType(.password)
                } else {
                    HStack {
                        Text("URL")
                        Spacer()
                        Text(gatewayURL.isEmpty ? "Not configured" : gatewayURL)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    
                    HStack {
                        Text("Token")
                        Spacer()
                        Text(gatewayToken.isEmpty ? "Not configured" : "••••••••")
                            .foregroundColor(.secondary)
                    }
                }
                
                Button(action: { showingQRScanner = true }) {
                    Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                }
            } header: {
                HStack {
                    Text("Gateway")
                    Spacer()
                    Button(isEditing ? "Done" : "Edit") {
                        if isEditing {
                            saveAndConnect()
                        }
                        isEditing.toggle()
                    }
                    .font(.caption)
                }
            } footer: {
                Text("Scan the QR code from your ThunderGate dashboard, or enter the URL and token manually.")
            }
            
            // Actions
            Section {
                if gateway.connectionStatus == .connected {
                    Button("Disconnect", role: .destructive) {
                        gateway.disconnect()
                    }
                } else if !gatewayURL.isEmpty && !gatewayToken.isEmpty {
                    Button("Connect") {
                        saveAndConnect()
                    }
                }
                
                Button("Reset Configuration", role: .destructive) {
                    gatewayURL = ""
                    gatewayToken = ""
                    gateway.disconnect()
                }
            }
            
            // Device Info
            Section {
                HStack {
                    Text("Device ID")
                    Spacer()
                    Text(deviceId)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                HStack {
                    Text("App Version")
                    Spacer()
                    Text(appVersion)
                        .foregroundColor(.secondary)
                }
            } header: {
                Text("Device")
            }
            
            // About
            Section {
                Link(destination: URL(string: "https://github.com/ThrustNThunder/thundergate")!) {
                    Label("GitHub Repository", systemImage: "link")
                }
                
                Link(destination: URL(string: "https://docs.openclaw.ai")!) {
                    Label("Documentation", systemImage: "book")
                }
            } header: {
                Text("About")
            } footer: {
                Text("ThunderComm — Sovereign agent communication.\nBuilt on ThunderGate (OpenClaw fork).")
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $showingQRScanner) {
            QRScannerView { result in
                handleQRCode(result)
                showingQRScanner = false
            }
        }
    }
    
    private var statusColor: Color {
        switch gateway.connectionStatus {
        case .connected: return .green
        case .connecting, .reconnecting: return .yellow
        default: return .red
        }
    }
    
    private var deviceId: String {
        UserDefaults.standard.string(forKey: "thundercomm_device_id") ?? "Unknown"
    }
    
    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
    
    private func saveAndConnect() {
        guard let url = URL(string: gatewayURL) else {
            return
        }
        gateway.configure(url: url, token: gatewayToken)
        gateway.connect()
    }
    
    private func handleQRCode(_ code: String) {
        // Expected format: thundercomm://host:port?token=xxx
        // or: {"url": "wss://...", "token": "xxx"}
        
        if let data = code.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
           let url = json["url"],
           let token = json["token"] {
            gatewayURL = url
            gatewayToken = token
            saveAndConnect()
            return
        }
        
        if let url = URL(string: code),
           url.scheme == "thundercomm",
           let token = url.queryParameters?["token"] {
            var components = URLComponents()
            components.scheme = "wss"
            components.host = url.host
            components.port = url.port
            components.path = url.path.isEmpty ? "/ws" : url.path
            
            if let wsURL = components.url {
                gatewayURL = wsURL.absoluteString
                gatewayToken = token
                saveAndConnect()
            }
        }
    }
}

// MARK: - QR Scanner (Placeholder)

struct QRScannerView: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) var dismiss
    
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 100))
                    .foregroundColor(.secondary)
                
                Text("QR Scanner")
                    .font(.headline)
                
                Text("Camera access required.\nPoint at ThunderGate QR code.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                
                // TODO: Implement actual camera scanning
                // Using AVCaptureSession + AVMetadataObject
            }
            .padding()
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

// MARK: - URL Extension

extension URL {
    var queryParameters: [String: String]? {
        guard let components = URLComponents(url: self, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            return nil
        }
        
        var params: [String: String] = [:]
        for item in queryItems {
            params[item.name] = item.value
        }
        return params
    }
}

// MARK: - Preview

#Preview {
    NavigationView {
        SettingsView()
            .environmentObject(GatewayService())
    }
}
