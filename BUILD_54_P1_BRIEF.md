# Build 54 — P1 Brief
**Issued by:** Jon | ThunderBase  
**Date:** May 17 2026  
**Task:** Wire DeliveryCore.inbound → ThunderCommStore.messages

---

## Context
Read https://github.com/ThrustNThunder/cli-jon-context for full project context before starting.

Repo: ThrustNThunder/thundergate-dev, branch: master  
iOS source: apps/ios/ThunderCommIOS/

## The Problem
Silent push arrives → APNsManager.handleSilentPush() → DeliveryCore.shared.drainInbox() → messages land in DeliveryCore.inbound (@Published [InboxMessage]).

Nobody is observing DeliveryCore.inbound. ThunderCommStore.messages never gets updated. User foregrounds the app and sees a blank/stale list.

## Files Involved
- DeliveryCore.swift — has `@Published public private(set) var inbound: [InboxMessage]`
- ThunderCommStore.swift — has `var messages: [ThunderCommMessage]`, uses its own `private let delivery = DeliveryStateCore()`
- APNsManager.swift.swift — calls `DeliveryCore.shared.drainInbox()` on silent push
- AppDelegate.swift — routes silent push to APNsManager.handleSilentPush

## What To Build

### Step 1 — Subscribe ThunderCommStore to DeliveryCore.inbound
In ThunderCommStore, add a Combine subscriber on DeliveryCore.shared.$inbound.

On every new message in inbound that isn't already in messages (check by id):
1. Convert InboxMessage → ThunderCommMessage
2. Append to self.messages on main thread
3. Persist via self.persistence

Add to ThunderCommStore.init():
```swift
DeliveryCore.shared.$inbound
    .receive(on: DispatchQueue.main)
    .sink { [weak self] newInbound in
        self?.handleInboundUpdate(newInbound)
    }
    .store(in: &cancellables)
```

Add a `private var cancellables = Set<AnyCancellable>()` if not already present.

### Step 2 — handleInboundUpdate(_:)
```swift
private func handleInboundUpdate(_ inbound: [InboxMessage]) {
    let existingIDs = Set(messages.map { $0.id })
    let newMessages = inbound
        .filter { !existingIDs.contains($0.id) }
        .map { ThunderCommMessage(from: $0) }  // use whatever init exists
    guard !newMessages.isEmpty else { return }
    messages.append(contentsOf: newMessages)
    newMessages.forEach { persistence.save($0) }
}
```

### Step 3 — Check InboxMessage → ThunderCommMessage conversion
Find how ThunderCommMessage is currently initialized from InboxMessage elsewhere in the codebase. Use the same init/factory pattern — do NOT invent a new one.

### Step 4 — Consolidate double drain (P2 scope — note only, don't fix now)
AppDelegate and APNsManager both call drainInbox. Note the locations but do NOT touch them in this pass — P1 only.

## Constraints
- Do NOT touch APNs stack (APNsManager, AppDelegate push registration)
- Do NOT touch the relay or bridge
- Do NOT modify DeliveryCore.inbound itself — subscribe to it, don't change it
- Write files directly to repo — do NOT print code to terminal
- Target build number: 54
- No push — write files only, Jon gates the diff

## Deliverables
1. ThunderCommStore.swift modified with Combine subscriber + handleInboundUpdate
2. Summary of every changed line posted back to Jon
3. ACTIVE_TASKS.md updated in cli-jon-context

## Gate (Jon runs before Mack builds)
- DeliveryCore.$inbound subscription is traceable in ThunderCommStore.init
- handleInboundUpdate deduplicates by id
- No regressions to APNs stack
- No changes outside ThunderCommStore.swift
