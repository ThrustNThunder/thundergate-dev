/**
 * ThunderComm Chat View
 * Main conversation interface.
 *
 * Jon | ThunderBase | 2026-05-05
 */

import SwiftUI

struct ChatView: View {
    @EnvironmentObject var gateway: GatewayService
    @State private var messageText = ""
    @State private var scrollToBottom = false
    @FocusState private var isInputFocused: Bool
    
    var body: some View {
        VStack(spacing: 0) {
            // Connection status bar
            if gateway.connectionStatus != .connected {
                StatusBar(status: gateway.connectionStatus)
            }
            
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(gateway.messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }
                        
                        // Thinking indicators
                        ForEach(Array(gateway.currentlyThinking), id: \.self) { agentId in
                            ThinkingIndicator(agentId: agentId)
                        }
                        
                        // Stream buffers (live typing)
                        ForEach(Array(gateway.streamBuffer.keys), id: \.self) { agentId in
                            if let text = gateway.streamBuffer[agentId], !text.isEmpty {
                                StreamingBubble(agentId: agentId, text: text)
                            }
                        }
                        
                        // Invisible anchor for scrolling
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                    }
                    .padding()
                }
                .onChange(of: gateway.messages.count) { _ in
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .onChange(of: gateway.streamBuffer) { _ in
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            
            // Pending actions
            if !gateway.pendingActions.isEmpty {
                ActionRequestsBar(actions: gateway.pendingActions)
            }
            
            // Input bar
            InputBar(
                text: $messageText,
                isFocused: $isInputFocused,
                onSend: sendMessage
            )
        }
        .navigationTitle("ThunderComm")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                AgentRosterButton(agents: gateway.agents)
            }
        }
    }
    
    private func sendMessage() {
        let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        
        gateway.sendText(trimmed)
        messageText = ""
    }
}

// MARK: - Status Bar

struct StatusBar: View {
    let status: ConnectionStatus
    
    var body: some View {
        HStack {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            
            Text(status.displayText)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(Color(.systemBackground).opacity(0.95))
    }
    
    private var statusColor: Color {
        switch status {
        case .connected: return .green
        case .connecting, .reconnecting: return .yellow
        default: return .red
        }
    }
}

// MARK: - Message Bubble

struct MessageBubble: View {
    let message: ConversationMessage
    
    var body: some View {
        HStack {
            if message.agentId == "user" {
                Spacer()
            }
            
            VStack(alignment: message.agentId == "user" ? .trailing : .leading, spacing: 4) {
                if message.agentId != "user" {
                    Text(message.agentId)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                Text(message.text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(bubbleColor)
                    .foregroundColor(textColor)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                
                Text(message.date, style: .time)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            
            if message.agentId != "user" {
                Spacer()
            }
        }
    }
    
    private var bubbleColor: Color {
        message.agentId == "user" ? .blue : Color(.systemGray5)
    }
    
    private var textColor: Color {
        message.agentId == "user" ? .white : .primary
    }
}

// MARK: - Thinking Indicator

struct ThinkingIndicator: View {
    let agentId: String
    @State private var dotCount = 0
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(agentId)
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                HStack(spacing: 4) {
                    ForEach(0..<3) { index in
                        Circle()
                            .fill(Color.secondary)
                            .frame(width: 6, height: 6)
                            .opacity(index <= dotCount ? 1.0 : 0.3)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(.systemGray5))
                .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            Spacer()
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever()) {
                dotCount = (dotCount + 1) % 3
            }
        }
    }
}

// MARK: - Streaming Bubble

struct StreamingBubble: View {
    let agentId: String
    let text: String
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(agentId)
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                Text(text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray5))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            Spacer()
        }
    }
}

// MARK: - Action Requests Bar

struct ActionRequestsBar: View {
    let actions: [ActionRequestMessage]
    @EnvironmentObject var gateway: GatewayService
    
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(actions) { action in
                    ActionRequestCard(action: action)
                }
            }
            .padding()
        }
        .background(Color(.systemGray6))
    }
}

struct ActionRequestCard: View {
    let action: ActionRequestMessage
    @EnvironmentObject var gateway: GatewayService
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(action.description)
                .font(.subheadline)
                .lineLimit(2)
            
            HStack(spacing: 8) {
                ForEach(action.actions, id: \.value) { option in
                    Button(option.label) {
                        gateway.respondToAction(action.id, value: option.value)
                    }
                    .buttonStyle(.bordered)
                    .tint(option.value == "approve" ? .green : (option.value == "cancel" ? .red : .blue))
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 2)
    }
}

// MARK: - Input Bar

struct InputBar: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void
    
    var body: some View {
        HStack(spacing: 12) {
            // Voice button (future)
            Button(action: {}) {
                Image(systemName: "mic.fill")
                    .foregroundColor(.secondary)
            }
            .disabled(true) // TODO: Enable when voice is implemented
            
            // Text field
            TextField("Message", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .focused(isFocused)
                .onSubmit(onSend)
            
            // Send button
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundColor(text.isEmpty ? .secondary : .blue)
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
    }
}

// MARK: - Agent Roster Button

struct AgentRosterButton: View {
    let agents: [AgentInfo]
    @State private var showingRoster = false
    
    var body: some View {
        Button(action: { showingRoster = true }) {
            HStack(spacing: 4) {
                Circle()
                    .fill(onlineCount > 0 ? .green : .gray)
                    .frame(width: 8, height: 8)
                
                Text("\(onlineCount)")
                    .font(.caption)
            }
        }
        .sheet(isPresented: $showingRoster) {
            AgentRosterSheet(agents: agents)
        }
    }
    
    private var onlineCount: Int {
        agents.filter { $0.status == .online }.count
    }
}

struct AgentRosterSheet: View {
    let agents: [AgentInfo]
    @Environment(\.dismiss) var dismiss
    
    var body: some View {
        NavigationView {
            List(agents) { agent in
                HStack {
                    Circle()
                        .fill(statusColor(for: agent.status))
                        .frame(width: 10, height: 10)
                    
                    VStack(alignment: .leading) {
                        Text(agent.name)
                            .font(.headline)
                        
                        if let role = agent.role {
                            Text(role)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                    
                    Spacer()
                    
                    Text(agent.status.rawValue.capitalized)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
    
    private func statusColor(for status: AgentStatus) -> Color {
        switch status {
        case .online: return .green
        case .busy: return .yellow
        case .offline: return .gray
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationView {
        ChatView()
            .environmentObject(GatewayService())
    }
}
