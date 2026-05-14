/**
 * VaultProviderRegistry — single mount-point for the four plugin
 * sockets defined in providers.ts.
 *
 * Today the registry boots with the V1 local implementations so vault
 * behavior is byte-identical to the pre-registry codebase. Tomorrow:
 *
 *   - Mack ships ThunderCommo iOS LocalAuthentication → BYOAA off-chain
 *     signed grants light up → swap auth provider:
 *       registry.registerAuthProvider(new BYOAAAuthorizationProvider(...))
 *
 *   - Alex's Loop receipt anchoring lands → swap anchor provider:
 *       registry.registerAnchorProvider(new LoopAnchorProvider(...))
 *
 *   - Loop capability classes / clearing house → swap authority:
 *       registry.registerCapabilityAuthority(new LoopCapabilityAuthority(...))
 *
 *   - ZKP layer ships → swap ZKP provider (currently null):
 *       registry.registerZKPProvider(new LoopZKPProvider(...))
 *
 * A registry instance is owned by the runtime (one per process). The
 * VaultService + VaultProtocol both consult the registry on every
 * request — no provider is cached, so a swap takes effect immediately.
 */

import type { Database as Db } from 'better-sqlite3';
import {
  LocalAuthorizationProvider,
  LocalCapabilityAuthority,
  LocalReceiptAnchorProvider,
  NullZKProofProvider,
  type AuthorizationProvider,
  type CapabilityAuthority,
  type LocalAuthorizationUnlockHandle,
  type ReceiptAnchorProvider,
  type ZKProofProvider
} from './providers.js';

export interface VaultProviderRegistryOptions {
  /** Pre-existing better-sqlite3 handle so the V1 local anchor provider
   *  can write through to vault_receipts. The handle is borrowed —
   *  ownership stays with VaultService. */
  db: Db;
  /** Unlock handle for the V1 local auth provider. Typically a thin
   *  closure binding VaultService.unlock. */
  unlockHandle: LocalAuthorizationUnlockHandle;
}

export interface VaultProviderInventory {
  authProvider: { kind: AuthorizationProvider['kind']; ctor: string };
  anchorProvider: { kind: ReceiptAnchorProvider['kind']; ctor: string };
  capabilityAuthority: { kind: CapabilityAuthority['kind']; ctor: string };
  zkpProvider: { kind: ZKProofProvider['kind']; ctor: string } | null;
}

export class VaultProviderRegistry {
  authProvider: AuthorizationProvider;
  anchorProvider: ReceiptAnchorProvider;
  capabilityAuthority: CapabilityAuthority;
  /**
   * ZKP is the only socket that legitimately stays null in V1 —
   * `NullZKProofProvider` is installed so callers that try to use it
   * get a clear error rather than a typeerror. We expose the
   * `null`-typed shape via getZKPProvider() so the runtime + doctor can
   * still report "not wired".
   */
  zkpProvider: ZKProofProvider | null;

  constructor(options: VaultProviderRegistryOptions) {
    this.authProvider = new LocalAuthorizationProvider(options.unlockHandle);
    this.anchorProvider = new LocalReceiptAnchorProvider(options.db);
    this.capabilityAuthority = new LocalCapabilityAuthority();
    // V1: ZKP is intentionally not wired. We install the Null provider
    // so a programmer mistake (using zkp without checking) surfaces a
    // clear "not available" error instead of dereferencing null.
    this.zkpProvider = new NullZKProofProvider();
  }

  registerAuthProvider(p: AuthorizationProvider): void {
    this.authProvider = p;
  }
  registerAnchorProvider(p: ReceiptAnchorProvider): void {
    this.anchorProvider = p;
  }
  registerCapabilityAuthority(p: CapabilityAuthority): void {
    this.capabilityAuthority = p;
  }
  registerZKPProvider(p: ZKProofProvider): void {
    this.zkpProvider = p;
  }

  /** Snapshot of currently-registered providers for `vault providers` CLI
   *  + doctor inventory. Reports `null`-shaped values when the slot is
   *  empty (only valid for ZKP today). */
  inventory(): VaultProviderInventory {
    return {
      authProvider: {
        kind: this.authProvider.kind,
        ctor: this.authProvider.constructor.name
      },
      anchorProvider: {
        kind: this.anchorProvider.kind,
        ctor: this.anchorProvider.constructor.name
      },
      capabilityAuthority: {
        kind: this.capabilityAuthority.kind,
        ctor: this.capabilityAuthority.constructor.name
      },
      zkpProvider: this.zkpProvider
        ? {
            kind: this.zkpProvider.kind,
            ctor: this.zkpProvider.constructor.name
          }
        : null
    };
  }
}
