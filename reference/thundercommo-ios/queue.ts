/**
 * ThunderCommo Message Queue
 * 
 * Handles offline reliability:
 * - Outbound: Queue locally, send when network available
 * - Inbound: Relay holds messages, flush on reconnect
 * 
 * Core reliability, not a feature.
 */

interface QueuedMessage {
  id: string;
  content: string;
  recipient: string;
  timestamp: Date;
  status: 'pending' | 'sending' | 'sent' | 'delivered' | 'failed';
  retryCount: number;
  lastAttempt?: Date;
}

interface InboundMessage {
  id: string;
  content: string;
  sender: string;
  timestamp: Date;
  received: boolean;
}

export class MessageQueue {
  private outbound: Map<string, QueuedMessage> = new Map();
  private inbound: Map<string, InboundMessage> = new Map();
  private maxRetries: number = 5;
  private retryBackoffMs: number = 1000;
  private isOnline: boolean = true;
  private flushInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start flush interval
    this.startFlushInterval();
  }

  /**
   * Queue outbound message for sending
   */
  queueOutbound(message: {
    id: string;
    content: string;
    recipient: string;
  }): QueuedMessage {
    const queued: QueuedMessage = {
      ...message,
      timestamp: new Date(),
      status: 'pending',
      retryCount: 0
    };

    this.outbound.set(message.id, queued);
    console.log(`  📤 Message queued: ${message.id}`);

    // Try to send immediately if online
    if (this.isOnline) {
      this.attemptSend(message.id);
    }

    return queued;
  }

  /**
   * Attempt to send a queued message
   */
  private async attemptSend(messageId: string): Promise<boolean> {
    const message = this.outbound.get(messageId);
    if (!message) return false;

    message.status = 'sending';
    message.lastAttempt = new Date();

    try {
      // TODO: Actual send via ThunderCommo relay
      // await this.relay.send(message);
      
      message.status = 'sent';
      console.log(`  ✓ Message sent: ${messageId}`);
      return true;

    } catch (error) {
      message.retryCount++;
      
      if (message.retryCount >= this.maxRetries) {
        message.status = 'failed';
        console.error(`  ✗ Message failed after ${this.maxRetries} retries: ${messageId}`);
      } else {
        message.status = 'pending';
        console.warn(`  ⟳ Message retry ${message.retryCount}/${this.maxRetries}: ${messageId}`);
      }
      
      return false;
    }
  }

  /**
   * Queue inbound message (from relay)
   */
  queueInbound(message: {
    id: string;
    content: string;
    sender: string;
  }): void {
    const queued: InboundMessage = {
      ...message,
      timestamp: new Date(),
      received: false
    };

    this.inbound.set(message.id, queued);
    console.log(`  📥 Inbound message queued: ${message.id}`);
  }

  /**
   * Flush inbound queue (called when app comes online/foreground)
   */
  flushInbound(): InboundMessage[] {
    const messages: InboundMessage[] = [];

    for (const [id, message] of this.inbound) {
      if (!message.received) {
        messages.push(message);
        message.received = true;
      }
    }

    console.log(`  📬 Flushed ${messages.length} inbound messages`);
    return messages;
  }

  /**
   * Flush outbound queue (retry pending messages)
   */
  async flushOutbound(): Promise<void> {
    if (!this.isOnline) return;

    const pending = Array.from(this.outbound.values())
      .filter(m => m.status === 'pending');

    console.log(`  📤 Flushing ${pending.length} outbound messages`);

    for (const message of pending) {
      // Exponential backoff
      const backoff = this.retryBackoffMs * Math.pow(2, message.retryCount);
      
      if (message.lastAttempt) {
        const elapsed = Date.now() - message.lastAttempt.getTime();
        if (elapsed < backoff) continue; // Wait for backoff
      }

      await this.attemptSend(message.id);
    }
  }

  /**
   * Set online status
   */
  setOnline(online: boolean): void {
    const wasOffline = !this.isOnline && online;
    this.isOnline = online;

    if (wasOffline) {
      console.log('  🌐 Back online — flushing queues');
      this.flushOutbound();
    }
  }

  /**
   * Start periodic flush interval
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flushOutbound();
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop flush interval
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /**
   * Get message status
   */
  getStatus(messageId: string): QueuedMessage['status'] | null {
    return this.outbound.get(messageId)?.status || null;
  }

  /**
   * Mark message as delivered (from delivery confirmation)
   */
  markDelivered(messageId: string): void {
    const message = this.outbound.get(messageId);
    if (message) {
      message.status = 'delivered';
      console.log(`  ✓✓ Message delivered: ${messageId}`);
    }
  }

  /**
   * Get queue stats
   */
  getStats(): {
    outboundPending: number;
    outboundSent: number;
    outboundFailed: number;
    inboundUnread: number;
  } {
    const outbound = Array.from(this.outbound.values());
    const inbound = Array.from(this.inbound.values());

    return {
      outboundPending: outbound.filter(m => m.status === 'pending').length,
      outboundSent: outbound.filter(m => m.status === 'sent' || m.status === 'delivered').length,
      outboundFailed: outbound.filter(m => m.status === 'failed').length,
      inboundUnread: inbound.filter(m => !m.received).length
    };
  }

  /**
   * Clear old messages from queue
   */
  cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;

    for (const [id, message] of this.outbound) {
      if (message.timestamp.getTime() < cutoff && 
          (message.status === 'delivered' || message.status === 'failed')) {
        this.outbound.delete(id);
      }
    }

    for (const [id, message] of this.inbound) {
      if (message.timestamp.getTime() < cutoff && message.received) {
        this.inbound.delete(id);
      }
    }
  }
}
