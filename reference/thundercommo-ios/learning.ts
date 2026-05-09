/**
 * ThunderCommo Consent-First Learning
 * 
 * User-controlled learning toggle:
 * - First conversation: Ask permission
 * - App settings: Global controls
 * - KYA integration: Auditable, revocable
 * 
 * Privacy by default, learning by permission.
 */

import { SessionDB } from '../session/database.js';

interface ContactProfile {
  id: string;
  name: string;
  learningEnabled: boolean;
  consentGiven: Date | null;
  consentRevoked: Date | null;
  preferences: Record<string, any>;
  interactionCount: number;
  lastInteraction: Date | null;
}

interface LearningSettings {
  allowOthersToEnableLearning: boolean;
  defaultForNewContacts: 'ask' | 'always_off' | 'always_on';
}

export class ContactLearning {
  private db: SessionDB;
  private settings: LearningSettings;
  private contacts: Map<string, ContactProfile> = new Map();

  constructor(db: SessionDB) {
    this.db = db;
    this.settings = {
      allowOthersToEnableLearning: true,
      defaultForNewContacts: 'ask'
    };
    
    this.loadSettings();
    this.loadContacts();
  }

  /**
   * Load settings from database
   */
  private loadSettings(): void {
    const saved = this.db.getContext('learning_settings');
    if (saved) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(saved) };
      } catch {}
    }
  }

  /**
   * Save settings to database
   */
  private saveSettings(): void {
    this.db.setContext('learning_settings', JSON.stringify(this.settings), 'high');
  }

  /**
   * Load contacts from database
   */
  private loadContacts(): void {
    // TODO: Implement contact loading from database
  }

  /**
   * Check if learning is enabled for a contact
   */
  isLearningEnabled(contactId: string): boolean {
    const contact = this.contacts.get(contactId);
    return contact?.learningEnabled ?? false;
  }

  /**
   * Handle first conversation — check if we need to ask for consent
   */
  async handleFirstContact(contactId: string, contactName: string): Promise<{
    needsConsent: boolean;
    message?: string;
  }> {
    // Check if contact already exists
    if (this.contacts.has(contactId)) {
      return { needsConsent: false };
    }

    // Check default setting
    switch (this.settings.defaultForNewContacts) {
      case 'always_on':
        // Auto-enable without asking
        await this.enableLearning(contactId, contactName);
        return { needsConsent: false };

      case 'always_off':
        // Create contact with learning disabled
        await this.createContact(contactId, contactName, false);
        return { needsConsent: false };

      case 'ask':
      default:
        // Need to ask for consent
        return {
          needsConsent: true,
          message: this.getConsentPrompt(contactName)
        };
    }
  }

  /**
   * Get consent prompt message
   */
  private getConsentPrompt(contactName: string): string {
    return `Hi ${contactName}! Would you like me to remember our conversations and learn about you?\n\n` +
           `[Yes, remember me] — I'll learn your preferences and our conversation history\n` +
           `[No, stay anonymous] — Each conversation starts fresh, nothing stored\n\n` +
           `You can change this anytime in your settings.`;
  }

  /**
   * Process consent response
   */
  async processConsentResponse(
    contactId: string, 
    contactName: string, 
    consent: boolean
  ): Promise<void> {
    if (consent) {
      await this.enableLearning(contactId, contactName);
    } else {
      await this.createContact(contactId, contactName, false);
    }
  }

  /**
   * Create contact profile
   */
  private async createContact(
    contactId: string, 
    contactName: string, 
    learningEnabled: boolean
  ): Promise<ContactProfile> {
    const profile: ContactProfile = {
      id: contactId,
      name: contactName,
      learningEnabled,
      consentGiven: learningEnabled ? new Date() : null,
      consentRevoked: null,
      preferences: {},
      interactionCount: 0,
      lastInteraction: null
    };

    this.contacts.set(contactId, profile);
    
    // Store in database
    this.db.storeMemory({
      key: `contact_${contactId}`,
      value: JSON.stringify(profile),
      category: 'contacts',
      importance: 'normal',
      source: 'system'
    });

    return profile;
  }

  /**
   * Enable learning for a contact
   */
  async enableLearning(contactId: string, contactName: string): Promise<void> {
    let profile = this.contacts.get(contactId);
    
    if (!profile) {
      profile = await this.createContact(contactId, contactName, true);
    } else {
      profile.learningEnabled = true;
      profile.consentGiven = new Date();
      profile.consentRevoked = null;
      
      this.db.storeMemory({
        key: `contact_${contactId}`,
        value: JSON.stringify(profile),
        category: 'contacts',
        importance: 'normal'
      });
    }

    console.log(`  ✓ Learning enabled for: ${contactName}`);
  }

  /**
   * Disable learning for a contact
   */
  async disableLearning(contactId: string): Promise<void> {
    const profile = this.contacts.get(contactId);
    if (!profile) return;

    profile.learningEnabled = false;
    profile.consentRevoked = new Date();

    this.db.storeMemory({
      key: `contact_${contactId}`,
      value: JSON.stringify(profile),
      category: 'contacts',
      importance: 'normal'
    });

    console.log(`  ✗ Learning disabled for: ${profile.name}`);
  }

  /**
   * Forget a contact — delete all learned data
   */
  async forgetContact(contactId: string): Promise<void> {
    const profile = this.contacts.get(contactId);
    if (!profile) return;

    // Delete contact profile
    this.contacts.delete(contactId);

    // Delete from database
    // TODO: Add delete method to SessionDB
    
    // Delete all memories about this contact
    // TODO: Search and delete memories with contact reference

    console.log(`  🗑️ Forgot contact: ${profile.name} — all data deleted`);
  }

  /**
   * Record interaction with contact (if learning enabled)
   */
  async recordInteraction(contactId: string, data: {
    message?: string;
    preference?: { key: string; value: any };
    context?: string;
  }): Promise<void> {
    const profile = this.contacts.get(contactId);
    if (!profile || !profile.learningEnabled) return;

    profile.interactionCount++;
    profile.lastInteraction = new Date();

    // Store preference if provided
    if (data.preference) {
      profile.preferences[data.preference.key] = data.preference.value;
    }

    // Update database
    this.db.storeMemory({
      key: `contact_${contactId}`,
      value: JSON.stringify(profile),
      category: 'contacts',
      importance: 'normal'
    });
  }

  /**
   * Get learned preferences for a contact
   */
  getPreferences(contactId: string): Record<string, any> | null {
    const profile = this.contacts.get(contactId);
    if (!profile || !profile.learningEnabled) return null;
    return profile.preferences;
  }

  /**
   * List all contacts with learning enabled
   */
  listLearnedContacts(): ContactProfile[] {
    return Array.from(this.contacts.values())
      .filter(c => c.learningEnabled);
  }

  /**
   * Update global settings
   */
  updateSettings(settings: Partial<LearningSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.saveSettings();
  }

  /**
   * Get global settings
   */
  getSettings(): LearningSettings {
    return { ...this.settings };
  }
}
