/**
 * ChannelTypeRegistry — pattern-based mapping from raw channel/session
 * keys to typed `ChannelType` values.
 *
 * Why this exists: bridges and adapters identify themselves with strings
 * like `thundercommo:tnt`, `slack:C0123`, `browser:peer-7`, or `cli`. The
 * runtime, posture machine, and frame manager all want a single typed
 * value (`ChannelType.THUNDERCOMMO`) to branch on. This registry is the
 * one place that knows the regex shape of each surface.
 *
 * Adding a new channel means:
 *   1. Add the enum value to `ChannelType` (in types.ts).
 *   2. Register its session-key pattern + channel-name here.
 *   3. Set its default reply preference in `types.ts`.
 *
 * The legacy `ChannelRegistry` (in `index.ts`) is unrelated — that one
 * holds running channel *instances*. This one is a static type map.
 */
import { ChannelType } from './types.js';
/**
 * A single mapping entry. `match` runs against either the
 * registered-channel `name` (e.g. "thundercommo") or the per-turn
 * channel key on a `ContextEntry` (e.g. "thundercommo:tnt"). First match
 * wins, so order matters: put narrower patterns above broader ones.
 */
export interface ChannelTypeMatcher {
    type: ChannelType;
    /** Regex tested against the channel name and the raw entry channel key. */
    match: RegExp;
    /** Human label used in CLI / Doctor output. */
    label: string;
}
export declare class ChannelTypeRegistry {
    private matchers;
    constructor(matchers?: ChannelTypeMatcher[]);
    /**
     * Resolve a raw channel key or registered-channel name to a typed
     * `ChannelType`. Returns `UNKNOWN` when nothing matches — callers
     * should treat that as "fall back to generic behavior", not "throw".
     */
    classify(rawKey: string | null | undefined): ChannelType;
    /**
     * Add or override a matcher. Newer matchers win over default ones
     * because we unshift onto the front of the list. Used by future
     * plugins to teach the registry about new surfaces without forking
     * core.
     */
    register(matcher: ChannelTypeMatcher): void;
    list(): readonly ChannelTypeMatcher[];
}
/** Singleton — wired into the runtime in core/runtime.ts. */
export declare const defaultChannelTypeRegistry: ChannelTypeRegistry;
