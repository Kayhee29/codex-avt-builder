/**
 * The predefined choices behind the builder's dropdowns (spec sections 4.1
 * and 4.3).
 *
 * Each option carries a stable `id` and the `value` that is stored in the
 * draft, written into `job.json` and rendered into `prompt.md`. **The value is
 * English** because `prompt.md` is an English document: the prompt builder
 * drops these into `- Pose: …` and `- Background: …`, and a Vietnamese value
 * would land inside an otherwise English prompt. The Vietnamese the user reads
 * is a label, and labels live in `src/renderer/i18n/vi.ts` like every other
 * display string.
 *
 * The ids are the join between the two. A label map typed
 * `Record<PoseOptionId, string>` fails `pnpm typecheck` when an option is added
 * without one, rather than showing a raw identifier in a dropdown.
 *
 * Nothing here narrows a schema. `subject.pose`, `subject.expression`,
 * `output.aspectRatio` and `output.background` stay `z.string()`, so a draft,
 * preset or anchor saved before these lists existed still parses, and the form
 * can offer "Khác…" for a value no list contains.
 */

export interface DirectionOption {
  /** Stable across label changes; the key a translation is looked up by. */
  readonly id: string
  /** What reaches `prompt.md`. English, and a phrase rather than a word. */
  readonly value: string
}

/**
 * Poses, from plain standing through action to framing.
 *
 * Framing entries (`portrait-bust`, `three-quarter`, `profile`) belong here
 * rather than in a list of their own: the prompt section they feed is "Pose,
 * expression and composition", and asking for two dropdowns to describe one
 * sentence would only invite them to contradict each other.
 */
export const POSE_OPTIONS = [
  { id: 'standing-relaxed', value: 'standing relaxed, weight on one leg' },
  { id: 'standing-front', value: 'standing straight, facing the viewer' },
  { id: 'heroic', value: 'a heroic stance, chest out and chin up' },
  { id: 'arms-crossed', value: 'standing with arms crossed' },
  { id: 'hands-on-hips', value: 'standing with hands on hips' },
  { id: 'hands-in-pockets', value: 'standing with hands in pockets' },
  { id: 'walking', value: 'mid-stride, walking toward the viewer' },
  { id: 'running', value: 'running at full stride' },
  { id: 'jumping', value: 'jumping, both feet off the ground' },
  { id: 'sitting-chair', value: 'sitting on a chair, leaning slightly forward' },
  { id: 'sitting-cross-legged', value: 'sitting cross-legged on the ground' },
  { id: 'crouching', value: 'crouching low, one hand on the ground' },
  { id: 'kneeling', value: 'kneeling on one knee' },
  { id: 'leaning', value: 'leaning against a wall' },
  { id: 'lying-down', value: 'lying down, propped on one elbow' },
  { id: 'looking-over-shoulder', value: 'turned away, looking back over one shoulder' },
  { id: 'back-turned', value: 'seen from behind, facing away' },
  { id: 'waving', value: 'waving one hand in greeting' },
  { id: 'pointing', value: 'pointing forward at the viewer' },
  { id: 'reaching', value: 'reaching one hand toward the viewer' },
  { id: 'combat-stance', value: 'a ready combat stance, guard up' },
  { id: 'meditating', value: 'seated in meditation, eyes closed' },
  { id: 'portrait-bust', value: 'a head and shoulders portrait, facing the viewer' },
  { id: 'three-quarter', value: 'a three-quarter view from the waist up' },
  { id: 'profile', value: 'a strict side profile' }
] as const satisfies readonly DirectionOption[]

export type PoseOptionId = (typeof POSE_OPTIONS)[number]['id']

/**
 * Expressions, spread across the range a character sheet usually needs rather
 * than clustered around "happy" and "angry".
 */
export const EXPRESSION_OPTIONS = [
  { id: 'neutral', value: 'neutral, relaxed features' },
  { id: 'slight-smile', value: 'a slight closed-mouth smile' },
  { id: 'warm-smile', value: 'a warm open smile' },
  { id: 'grin', value: 'a wide grin showing teeth' },
  { id: 'laughing', value: 'laughing, eyes creased' },
  { id: 'serious', value: 'serious and composed' },
  { id: 'stern', value: 'stern, brows drawn together' },
  { id: 'determined', value: 'determined, jaw set' },
  { id: 'confident', value: 'confident, one eyebrow raised' },
  { id: 'smug', value: 'smug, a one-sided smirk' },
  { id: 'angry', value: 'angry, teeth clenched' },
  { id: 'furious', value: 'furious, shouting' },
  { id: 'sad', value: 'sad, eyes downcast' },
  { id: 'crying', value: 'crying, tears on the cheeks' },
  { id: 'worried', value: 'worried, brows raised in the middle' },
  { id: 'fearful', value: 'fearful, eyes wide' },
  { id: 'surprised', value: 'surprised, mouth open' },
  { id: 'shocked', value: 'shocked, recoiling slightly' },
  { id: 'curious', value: 'curious, head tilted' },
  { id: 'thoughtful', value: 'thoughtful, gaze off to one side' },
  { id: 'bored', value: 'bored, eyelids lowered' },
  { id: 'sleepy', value: 'sleepy, eyes half closed' },
  { id: 'shy', value: 'shy, looking away' },
  { id: 'embarrassed', value: 'embarrassed, cheeks flushed' },
  { id: 'playful', value: 'playful, tongue out' },
  { id: 'calm', value: 'calm and serene' },
  { id: 'proud', value: 'proud, chin lifted' },
  { id: 'disgusted', value: 'disgusted, nose wrinkled' }
] as const satisfies readonly DirectionOption[]

export type ExpressionOptionId = (typeof EXPRESSION_OPTIONS)[number]['id']

/**
 * Aspect ratios as `width:height`, which is how the prompt states them and how
 * `result.json` reports what was actually produced.
 */
export const ASPECT_RATIO_OPTIONS = [
  { id: 'square', value: '1:1' },
  { id: 'portrait-4-5', value: '4:5' },
  { id: 'portrait-3-4', value: '3:4' },
  { id: 'portrait-2-3', value: '2:3' },
  { id: 'portrait-9-16', value: '9:16' },
  { id: 'landscape-4-3', value: '4:3' },
  { id: 'landscape-3-2', value: '3:2' },
  { id: 'landscape-16-9', value: '16:9' }
] as const satisfies readonly DirectionOption[]

export type AspectRatioOptionId = (typeof ASPECT_RATIO_OPTIONS)[number]['id']

/**
 * Backgrounds.
 *
 * `transparent` is offered whatever the chosen format, although JPEG cannot
 * carry it. The prompt is a request and not a guarantee (spec section 6.2), and
 * `result.json` records the file that was really produced, so a contradiction
 * here shows up as a measured fact rather than as a UI rule.
 */
export const BACKGROUND_OPTIONS = [
  { id: 'transparent', value: 'transparent' },
  { id: 'white', value: 'solid white' },
  { id: 'black', value: 'solid black' },
  { id: 'flat-colour', value: 'a single flat colour' },
  { id: 'soft-gradient', value: 'a soft gradient' },
  { id: 'studio', value: 'a plain studio backdrop' },
  { id: 'simple-environment', value: 'a simple environment that suits the subject' },
  { id: 'blurred', value: 'a blurred background with shallow depth of field' },
  { id: 'match-style', value: 'the background treatment of the style reference' }
] as const satisfies readonly DirectionOption[]

export type BackgroundOptionId = (typeof BACKGROUND_OPTIONS)[number]['id']

/**
 * How many images one job asks for.
 *
 * Kept short on purpose: every image costs a generation, and a job that wants
 * more is better run twice than mistyped once.
 */
export const COUNT_OPTIONS = [1, 2, 3, 4] as const

/**
 * The option a stored value came from, or `undefined` when it came from
 * somewhere else.
 *
 * `undefined` is the signal the form needs, not an error: a draft saved before
 * these lists existed, or one the user typed into "Khác…", holds a value no
 * list knows, and it has to stay in the box rather than be dropped.
 */
export function findOptionByValue(
  options: readonly DirectionOption[],
  value: string
): DirectionOption | undefined {
  return options.find((option) => option.value === value)
}
