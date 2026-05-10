// AddAgentView.swift
//
// Bring-Your-Own-Agent-Adapter (BYOAA) flow. Four steps:
//   1. Choose: scan QR or enter manually.
//   2a. QR — AVCaptureSession + AVCaptureMetadataOutput parse a
//       thundercommo:// URL and pre-fill the form.
//   2b. Manual — type host/token directly.
//   3. KYA verify — hit GET {httpURL}/api/agent/identity with the token,
//       show the agent's display name + emoji + fingerprint, ask "yes or no".
//       The user is the trust anchor here. We don't auto-pin.
//   4. Connected — write the connection + token to UserStore and dismiss.

import SwiftUI
import AVFoundation
import UIKit

public struct AddAgentView: View {

    public enum Step { case choose, qr, manual, verify, done }

    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = UserStore.shared

    @State private var step: Step = .choose

    @State private var agentName: String = "Jon"
    @State private var agentEmoji: String = "⚡"
    @State private var wsURL: String = "wss://thunderai.us"
    @State private var httpURL: String = "https://thunderai.us"
    @State private var token: String = ""

    @State private var isVerifying = false
    @State private var fetchedKYA: KYAIdentity?
    @State private var verifyError: String?

    public var onAdded: ((AgentConnection) -> Void)?

    public init(onAdded: ((AgentConnection) -> Void)? = nil) {
        self.onAdded = onAdded
    }

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add Agent")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .choose: chooseStep
        case .qr:     qrStep
        case .manual: manualStep
        case .verify: verifyStep
        case .done:   doneStep
        }
    }

    // MARK: - Step 1: choose

    private var chooseStep: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("How do you want to connect?")
                .font(.title2.bold())
                .multilineTextAlignment(.center)

            Button {
                step = .qr
            } label: {
                Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
                    .padding()
            }
            .buttonStyle(.borderedProminent)

            Button {
                step = .manual
            } label: {
                Label("Enter manually", systemImage: "keyboard")
                    .frame(maxWidth: .infinity)
                    .padding()
            }
            .buttonStyle(.bordered)

            Spacer()
        }
        .padding()
    }

    // MARK: - Step 2a: QR

    private var qrStep: some View {
        VStack {
            QRScannerView { code in
                if parse(qrPayload: code) { step = .verify }
            }
            .frame(maxHeight: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding()

            Text("Point at the agent's QR code")
                .foregroundStyle(.secondary)

            Button("Enter manually instead") { step = .manual }
                .padding()
        }
    }

    // Accepts thundercommo://add?ws=...&http=...&token=...&name=...&emoji=...
    private func parse(qrPayload: String) -> Bool {
        guard let comps = URLComponents(string: qrPayload),
              comps.scheme == "thundercommo" else { return false }
        let q = Dictionary(uniqueKeysWithValues:
            (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") }
        )
        if let v = q["ws"]    { wsURL = v }
        if let v = q["http"]  { httpURL = v }
        if let v = q["token"] { token = v }
        if let v = q["name"]  { agentName = v }
        if let v = q["emoji"] { agentEmoji = v }
        return !token.isEmpty && !httpURL.isEmpty
    }

    // MARK: - Step 2b: manual

    private var manualStep: some View {
        Form {
            Section("Agent") {
                TextField("Name", text: $agentName)
                TextField("Emoji", text: $agentEmoji)
            }
            Section("Endpoints") {
                TextField("WebSocket URL", text: $wsURL)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                TextField("HTTP URL", text: $httpURL)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }
            Section("Token") {
                SecureField("Bearer token", text: $token)
                    .textContentType(.password)
            }
            Section {
                Button("Verify Agent") { step = .verify }
                    .disabled(token.isEmpty || httpURL.isEmpty)
            }
        }
    }

    // MARK: - Step 3: verify (KYA)

    private var verifyStep: some View {
        VStack(spacing: 20) {
            if isVerifying {
                ProgressView("Talking to gateway…")
                    .padding(.top, 60)
                Spacer()
            } else if let kya = fetchedKYA {
                Spacer()
                Text(kya.emoji).font(.system(size: 84))
                Text(kya.displayName).font(.largeTitle.bold())
                VStack(alignment: .leading, spacing: 6) {
                    Text("Identity fingerprint")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(kya.fingerprint)
                        .font(.system(.body, design: .monospaced))
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.gray.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }.padding(.horizontal)

                Spacer()

                Button("This is the agent I want to connect") { confirm(kya: kya) }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)

                Button("Something looks wrong") { step = .manual }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
            } else if let verifyError {
                Spacer()
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.orange)
                Text("Couldn't verify").font(.title2.bold())
                Text(verifyError)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                Spacer()
                Button("Try again") { fetchKYA() }
                    .buttonStyle(.borderedProminent)
                Button("Edit details") { step = .manual }
                    .buttonStyle(.borderless)
            } else {
                Color.clear.onAppear { fetchKYA() }
            }
        }
        .padding()
    }

    private func fetchKYA() {
        verifyError = nil
        fetchedKYA = nil
        isVerifying = true

        guard let url = URL(string: httpURL + "/api/agent/identity") else {
            isVerifying = false
            verifyError = "HTTP URL is invalid."
            return
        }

        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 12

        Task {
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                guard let http = resp as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if http.statusCode == 401 {
                    isVerifying = false
                    verifyError = "Token rejected. Double-check it."
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                struct Response: Decodable {
                    let agent_id: String
                    let display_name: String?
                    let emoji: String?
                    let fingerprint: String
                }
                let r = try JSONDecoder().decode(Response.self, from: data)
                let kya = KYAIdentity(
                    agentId: r.agent_id,
                    displayName: r.display_name ?? agentName,
                    emoji: r.emoji ?? agentEmoji,
                    fingerprint: r.fingerprint,
                    verifiedAt: Date()
                )
                isVerifying = false
                fetchedKYA = kya
            } catch {
                isVerifying = false
                verifyError = error.localizedDescription
            }
        }
    }

    private func confirm(kya: KYAIdentity) {
        let connection = AgentConnection(
            agentName: kya.displayName,
            agentEmoji: kya.emoji,
            wsURL: wsURL,
            httpURL: httpURL,
            kya: kya,
            isDefault: store.currentUser?.agents.isEmpty ?? true
        )
        store.addAgent(connection, token: token)
        onAdded?(connection)
        step = .done
    }

    // MARK: - Step 4: done

    private var doneStep: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 84))
                .foregroundStyle(.green)
            Text("Agent connected")
                .font(.largeTitle.bold())
            if let kya = fetchedKYA {
                Text("\(kya.emoji) \(kya.displayName)")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
        }
        .padding()
    }
}

// MARK: - QR Scanner

public struct QRScannerView: UIViewControllerRepresentable {

    public var onCode: (String) -> Void

    public init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
    }

    public func makeUIViewController(context: Context) -> QRScannerController {
        let vc = QRScannerController()
        vc.onCode = onCode
        return vc
    }

    public func updateUIViewController(_ uiViewController: QRScannerController,
                                       context: Context) { }
}

public final class QRScannerController: UIViewController,
                                        AVCaptureMetadataOutputObjectsDelegate {

    fileprivate var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var hasFired = false

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
        }
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input  = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
    }

    public func metadataOutput(_ output: AVCaptureMetadataOutput,
                               didOutput metadataObjects: [AVMetadataObject],
                               from connection: AVCaptureConnection) {
        guard !hasFired,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let str = obj.stringValue else { return }
        hasFired = true
        onCode?(str)
    }
}
