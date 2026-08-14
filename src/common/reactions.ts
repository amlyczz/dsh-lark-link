// Reaction receipts: random reaction on inbound (pool excludes the DONE
// marker), DONE only on task completion. Contains ONLY Feishu-valid emoji
// types — the set below is the authoritative scrape of the Feishu reaction
// emoji_type catalog (pi-feishu-link 2026-08-13, verified live). Case
// sensitive: Fire is valid, FIRE is not; invalid types make addReaction
// fail with 231001 "reaction type is invalid".
// Harness-agnostic pure module.

/** All Feishu-valid emoji_type values (open.feishu.cn …/emojis-introduce). */
export const VALID_EMOJI_TYPES: ReadonlySet<string> = new Set([
	"OK",
	"THUMBSUP",
	"THANKS",
	"MUSCLE",
	"FINGERHEART",
	"APPLAUSE",
	"FISTBUMP",
	"JIAYI",
	"DONE",
	"SMILE",
	"BLUSH",
	"LAUGH",
	"SMIRK",
	"LOL",
	"FACEPALM",
	"LOVE",
	"WINK",
	"PROUD",
	"WITTY",
	"SMART",
	"SCOWL",
	"THINKING",
	"SOB",
	"CRY",
	"ERROR",
	"NOSEPICK",
	"HAUGHTY",
	"SLAP",
	"SPITBLOOD",
	"TOASTED",
	"GLANCE",
	"DULL",
	"INNOCENTSMILE",
	"JOYFUL",
	"WOW",
	"TRICK",
	"YEAH",
	"ENOUGH",
	"TEARS",
	"EMBARRASSED",
	"KISS",
	"SMOOCH",
	"DROOL",
	"OBSESSED",
	"MONEY",
	"TEASE",
	"SHOWOFF",
	"COMFORT",
	"CLAP",
	"PRAISE",
	"STRIVE",
	"XBLUSH",
	"SILENT",
	"WAVE",
	"WHAT",
	"FROWN",
	"SHY",
	"DIZZY",
	"LOOKDOWN",
	"CHUCKLE",
	"WAIL",
	"CRAZY",
	"WHIMPER",
	"HUG",
	"BLUBBER",
	"WRONGED",
	"HUSKY",
	"SHHH",
	"SMUG",
	"ANGRY",
	"HAMMER",
	"SHOCKED",
	"TERROR",
	"PETRIFIED",
	"SKULL",
	"SWEAT",
	"SPEECHLESS",
	"SLEEP",
	"DROWSY",
	"YAWN",
	"SICK",
	"PUKE",
	"BETRAYED",
	"HEADSET",
	"EatingFood",
	"MeMeMe",
	"Sigh",
	"Typing",
	"Lemon",
	"Get",
	"LGTM",
	"OnIt",
	"OneSecond",
	"VRHeadset",
	"YouAreTheBest",
	"SALUTE",
	"SHAKE",
	"HIGHFIVE",
	"UPPERLEFT",
	"ThumbsDown",
	"SLIGHT",
	"TONGUE",
	"EYESCLOSED",
	"RoarForYou",
	"CALF",
	"BEAR",
	"BULL",
	"RAINBOWPUKE",
	"ROSE",
	"HEART",
	"PARTY",
	"LIPS",
	"BEER",
	"CAKE",
	"GIFT",
	"CUCUMBER",
	"Drumstick",
	"Pepper",
	"CANDIEDHAWS",
	"BubbleTea",
	"Coffee",
	"Yes",
	"No",
	"OKR",
	"CheckMark",
	"CrossMark",
	"MinusOne",
	"Hundred",
	"AWESOMEN",
	"Pin",
	"Alarm",
	"Loudspeaker",
	"Trophy",
	"Fire",
	"BOMB",
	"Music",
	"XmasTree",
	"Snowman",
	"XmasHat",
	"FIREWORKS",
	"REDPACKET",
	"FORTUNE",
	"LUCK",
	"FIRECRACKER",
	"StickyRiceBalls",
	"HEARTBROKEN",
	"POOP",
	"StatusFlashOfInspiration",
	"CLEAVER",
	"Soccer",
	"Basketball",
	"GeneralDoNotDisturb",
	"Status_PrivateMessage",
	"GeneralInMeetingBusy",
	"StatusReading",
	"StatusInFlight",
	"GeneralBusinessTrip",
	"GeneralWorkFromHome",
	"StatusEnjoyLife",
	"GeneralTravellingCar",
	"StatusBus",
	"GeneralSun",
	"GeneralMoonRest",
	"MoonRabbit",
	"Mooncake",
	"JubilantRabbit",
	"TV",
	"Movie",
	"Pumpkin",
	"BeamingFace",
	"Delighted",
	"ColdSweat",
	"FullMoonFace",
	"Partying",
	"GoGoGo",
	"ThanksFace",
	"SaluteFace",
	"Shrug",
	"ClownFace",
	"HappyDragon",
]);

/** Completion marker — never part of the random pool. */
export const DONE_EMOJI = "DONE";

/**
 * Default random receipt pool (all Feishu-valid). 2026-08-08 pi fix:
 * FIRE → Fire (case-sensitive); ROCKET/SUN/WHITE_CHECK_MARK are NOT valid
 * Feishu emoji_type values and cause addReaction 231001.
 */
export const DEFAULT_RANDOM_POOL: readonly string[] = [
	"THUMBSUP",
	"OK",
	"HEART",
	"LAUGH",
	"SMILE",
	"WOW",
	"CLAP",
	"Fire",
];

export interface ReactionPicker {
	/** Random receipt reaction — never the DONE marker. */
	pickRandom(): string | undefined;
	/** Completion marker reaction. */
	done(): string;
}

/**
 * Build a reaction picker from a configured pool. Filters out any type not in
 * VALID_EMOJI_TYPES (fail-safe: a stale config cannot 400 the bridge) AND the
 * DONE marker (completion marker never participates in the random pool);
 * falls back to the default pool when nothing valid remains.
 */
export function createReactionPicker(
	pool: readonly string[],
	done: string,
): ReactionPicker {
	const validPool = pool.filter((t) => VALID_EMOJI_TYPES.has(t) && t !== done);
	const effectivePool =
		validPool.length > 0
			? validPool
			: DEFAULT_RANDOM_POOL.filter((t) => t !== done);
	const effectiveDone = VALID_EMOJI_TYPES.has(done) ? done : DONE_EMOJI;
	return {
		pickRandom() {
			if (effectivePool.length === 0) return undefined;
			return effectivePool[Math.floor(Math.random() * effectivePool.length)];
		},
		done: () => effectiveDone,
	};
}
