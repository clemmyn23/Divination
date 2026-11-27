// Slack sends an emoji as its name between colons (":wave:"). The page shows the emoji.
//
// The table holds the standard names that turn up in work chat, not all of them. A name it
// does not hold is taken for one of the workspace's own emoji, which is a picture on
// Slack's servers and has no character: it is left out of the line. The page loads
// nothing from elsewhere, so it cannot show that picture.

const EMOJI: Record<string, string> = {
  // Faces
  grinning: "😀", smiley: "😃", smile: "😄", grin: "😁", laughing: "😆", satisfied: "😆", sweat_smile: "😅",
  rolling_on_the_floor_laughing: "🤣", joy: "😂", slightly_smiling_face: "🙂", simple_smile: "🙂", upside_down_face: "🙃",
  wink: "😉", blush: "😊", innocent: "😇", smiling_face_with_3_hearts: "🥰", heart_eyes: "😍", "star-struck": "🤩",
  kissing_heart: "😘", yum: "😋", stuck_out_tongue: "😛", stuck_out_tongue_winking_eye: "😜", zany_face: "🤪",
  money_mouth_face: "🤑", hugging_face: "🤗", face_with_hand_over_mouth: "🤭", shushing_face: "🤫", thinking_face: "🤔",
  zipper_mouth_face: "🤐", face_with_raised_eyebrow: "🤨", neutral_face: "😐", expressionless: "😑", no_mouth: "😶",
  smirk: "😏", unamused: "😒", face_with_rolling_eyes: "🙄", grimacing: "😬", relieved: "😌", pensive: "😔",
  sleepy: "😪", sleeping: "😴", mask: "😷", face_with_thermometer: "🤒", nauseated_face: "🤢", sneezing_face: "🤧",
  hot_face: "🥵", cold_face: "🥶", dizzy_face: "😵", exploding_head: "🤯", face_with_cowboy_hat: "🤠", partying_face: "🥳",
  sunglasses: "😎", nerd_face: "🤓", face_with_monocle: "🧐", confused: "😕", worried: "😟", slightly_frowning_face: "🙁",
  open_mouth: "😮", hushed: "😯", astonished: "😲", flushed: "😳", pleading_face: "🥺", fearful: "😨", cold_sweat: "😰",
  disappointed_relieved: "😥", cry: "😢", sob: "😭", scream: "😱", confounded: "😖", persevere: "😣", disappointed: "😞",
  sweat: "😓", weary: "😩", tired_face: "😫", yawning_face: "🥱", triumph: "😤", rage: "😡", angry: "😠",
  face_with_symbols_on_mouth: "🤬", smiling_imp: "😈", skull: "💀", skull_and_crossbones: "☠️", hankey: "💩", poop: "💩",
  clown_face: "🤡", ghost: "👻", alien: "👽", robot_face: "🤖", melting_face: "🫠", saluting_face: "🫡",
  face_holding_back_tears: "🥹", smiling_face_with_tear: "🥲", face_with_peeking_eye: "🫣",
  see_no_evil: "🙈", hear_no_evil: "🙉", speak_no_evil: "🙊",

  // Hearts and marks of feeling
  heart: "❤️", orange_heart: "🧡", yellow_heart: "💛", green_heart: "💚", blue_heart: "💙", purple_heart: "💜",
  black_heart: "🖤", white_heart: "🤍", broken_heart: "💔", sparkling_heart: "💖", two_hearts: "💕", heartpulse: "💗",
  "100": "💯", boom: "💥", collision: "💥", sweat_drops: "💦", dash: "💨", zzz: "💤", anger: "💢",
  speech_balloon: "💬", thought_balloon: "💭",

  // Hands and people
  wave: "👋", raised_hand: "✋", hand: "✋", ok_hand: "👌", pinched_fingers: "🤌", v: "✌️", crossed_fingers: "🤞",
  the_horns: "🤘", call_me_hand: "🤙", point_left: "👈", point_right: "👉", point_up_2: "👆", point_down: "👇",
  point_up: "☝️", "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", fist: "✊", facepunch: "👊", punch: "👊",
  clap: "👏", raised_hands: "🙌", open_hands: "👐", handshake: "🤝", pray: "🙏", writing_hand: "✍️", muscle: "💪",
  heart_hands: "🫶", eyes: "👀", eye: "👁️", brain: "🧠",
  bow: "🙇", "man-bowing": "🙇‍♂️", "woman-bowing": "🙇‍♀️", face_palm: "🤦", shrug: "🤷", "man-shrugging": "🤷‍♂️",
  "woman-shrugging": "🤷‍♀️", raising_hand: "🙋", no_good: "🙅", ok_woman: "🙆", dancer: "💃", man_dancing: "🕺",
  running: "🏃", runner: "🏃", walking: "🚶", technologist: "🧑‍💻", "man-technologist": "👨‍💻", "woman-technologist": "👩‍💻",

  // Animals and nature
  dog: "🐶", cat: "🐱", bee: "🐝", honeybee: "🐝", bug: "🐛", ant: "🐜", ladybug: "🐞", lady_beetle: "🐞", butterfly: "🦋",
  turtle: "🐢", snail: "🐌", unicorn_face: "🦄", penguin: "🐧", bird: "🐦", monkey: "🐒", crab: "🦀", whale: "🐳",
  octopus: "🐙",
  sunny: "☀️", cloud: "☁️", rain_cloud: "🌧️", umbrella_with_rain_drops: "☔", snowflake: "❄️", zap: "⚡", fire: "🔥",
  droplet: "💧", ocean: "🌊", rainbow: "🌈", star: "⭐", star2: "🌟", sparkles: "✨", dizzy: "💫", sun_with_face: "🌞",
  crescent_moon: "🌙", earth_americas: "🌎", earth_africa: "🌍", earth_asia: "🌏", seedling: "🌱", evergreen_tree: "🌲",
  deciduous_tree: "🌳", palm_tree: "🌴", four_leaf_clover: "🍀", cherry_blossom: "🌸", rose: "🌹", sunflower: "🌻",
  tulip: "🌷", christmas_tree: "🎄",

  // Food and drink
  coffee: "☕", tea: "🍵", beer: "🍺", beers: "🍻", wine_glass: "🍷", cocktail: "🍸", champagne: "🍾",
  clinking_glasses: "🥂", pizza: "🍕", hamburger: "🍔", fries: "🍟", taco: "🌮", burrito: "🌯", cake: "🍰",
  birthday: "🎂", cupcake: "🧁", cookie: "🍪", doughnut: "🍩", popcorn: "🍿", apple: "🍎", banana: "🍌", avocado: "🥑",
  dumpling: "🥟", sushi: "🍣", ramen: "🍜", croissant: "🥐", pie: "🥧",

  // Celebration, travel and things
  tada: "🎉", confetti_ball: "🎊", balloon: "🎈", gift: "🎁", trophy: "🏆", medal: "🏅", sports_medal: "🏅",
  first_place_medal: "🥇", dart: "🎯", crown: "👑", gem: "💎", rocket: "🚀", airplane: "✈️", car: "🚗", bike: "🚲",
  ship: "🚢", truck: "🚚", house: "🏠", office: "🏢", hospital: "🏥", door: "🚪",
  bulb: "💡", flashlight: "🔦", wrench: "🔧", hammer: "🔨", hammer_and_wrench: "🛠️", gear: "⚙️", nut_and_bolt: "🔩",
  link: "🔗", paperclip: "📎", scissors: "✂️", lock: "🔒", unlock: "🔓", key: "🔑", shield: "🛡️", bomb: "💣",
  bell: "🔔", no_bell: "🔕", loudspeaker: "📢", mega: "📣", speaker: "🔈", mute: "🔇", mag: "🔍", mag_right: "🔎",
  microscope: "🔬", telescope: "🔭", test_tube: "🧪", dna: "🧬", pill: "💊", syringe: "💉", thermometer: "🌡️",
  computer: "💻", desktop_computer: "🖥️", keyboard: "⌨️", iphone: "📱", phone: "☎️", telephone: "☎️",
  telephone_receiver: "📞", email: "✉️", envelope: "✉️", incoming_envelope: "📨", inbox_tray: "📥", outbox_tray: "📤",
  package: "📦", memo: "📝", pencil: "📝", pencil2: "✏️", book: "📖", books: "📚", notebook: "📓", bookmark: "🔖",
  clipboard: "📋", calendar: "📆", date: "📅", spiral_calendar_pad: "🗓️", spiral_note_pad: "🗒️", thread: "🧵",
  chart_with_upwards_trend: "📈", chart_with_downwards_trend: "📉", bar_chart: "📊", file_folder: "📁",
  open_file_folder: "📂", page_facing_up: "📄", newspaper: "📰", pushpin: "📌", round_pushpin: "📍",
  triangular_flag_on_post: "🚩", checkered_flag: "🏁", white_flag: "🏳️", moneybag: "💰", dollar: "💵", credit_card: "💳",
  hourglass: "⌛", hourglass_flowing_sand: "⏳", watch: "⌚", alarm_clock: "⏰", stopwatch: "⏱️", timer_clock: "⏲️",
  camera: "📷", movie_camera: "🎥", video_camera: "📹", tv: "📺", headphones: "🎧", microphone: "🎤",
  musical_note: "🎵", notes: "🎶", art: "🎨", game_die: "🎲", video_game: "🎮", jigsaw: "🧩", soccer: "⚽",
  basketball: "🏀", football: "🏈", tennis: "🎾", ski: "🎿", skier: "⛷️", snowboarder: "🏂",
  broom: "🧹", wastebasket: "🗑️", crystal_ball: "🔮", magic_wand: "🪄",
  construction: "🚧", rotating_light: "🚨", traffic_light: "🚥", vertical_traffic_light: "🚦", octagonal_sign: "🛑",
  fire_engine: "🚒", ambulance: "🚑",

  // Signs
  white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️", x: "❌", negative_squared_cross_mark: "❎",
  heavy_multiplication_x: "✖️", heavy_plus_sign: "➕", heavy_minus_sign: "➖", question: "❓", grey_question: "❔",
  exclamation: "❗", heavy_exclamation_mark: "❗", grey_exclamation: "❕", bangbang: "‼️", interrobang: "⁉️",
  warning: "⚠️", no_entry: "⛔", no_entry_sign: "🚫", sos: "🆘", information_source: "ℹ️", new: "🆕", ok: "🆗",
  up: "🆙", cool: "🆒", free: "🆓", soon: "🔜", top: "🔝", back: "🔙", end: "🔚", on: "🔛", recycle: "♻️",
  arrow_right: "➡️", arrow_left: "⬅️", arrow_up: "⬆️", arrow_down: "⬇️", arrow_upper_right: "↗️",
  arrow_lower_right: "↘️", arrow_lower_left: "↙️", arrow_upper_left: "↖️", arrows_counterclockwise: "🔄",
  arrows_clockwise: "🔃", repeat: "🔁", leftwards_arrow_with_hook: "↩️", arrow_right_hook: "↪️", arrow_forward: "▶️",
  arrow_backward: "◀️", double_vertical_bar: "⏸️", black_square_for_stop: "⏹️", fast_forward: "⏩", rewind: "⏪",
  red_circle: "🔴", large_orange_circle: "🟠", large_yellow_circle: "🟡", large_green_circle: "🟢",
  large_blue_circle: "🔵", large_purple_circle: "🟣", white_circle: "⚪", black_circle: "⚫", large_red_square: "🟥",
  large_orange_square: "🟧", large_yellow_square: "🟨", large_green_square: "🟩", large_blue_square: "🟦",
  large_purple_square: "🟪", white_large_square: "⬜", black_large_square: "⬛", small_red_triangle: "🔺",
  small_red_triangle_down: "🔻", small_orange_diamond: "🔸", small_blue_diamond: "🔹", large_orange_diamond: "🔶",
  large_blue_diamond: "🔷", radio_button: "🔘",
  zero: "0️⃣", one: "1️⃣", two: "2️⃣", three: "3️⃣", four: "4️⃣", five: "5️⃣", six: "6️⃣", seven: "7️⃣", eight: "8️⃣",
  nine: "9️⃣", keycap_ten: "🔟", hash: "#️⃣", "1234": "🔢", abc: "🔤", tm: "™️", copyright: "©️", registered: "®️",
  infinity: "♾️", heavy_dollar_sign: "💲",
};

// ":skin-tone-2:" to ":skin-tone-6:" follow the emoji they colour, lightest first.
const SKIN_TONES = ["🏻", "🏼", "🏽", "🏾", "🏿"];
const SKIN_TONE = /^skin-tone-([2-6])$/;
const FLAG = /^flag-([a-z]{2})$/;
// The first of the 26 letters that pair up into a flag.
const FLAG_A = 0x1f1e6;

/** The character for a shortcode's name, or undefined when it has none here. */
function character(name: string): string | undefined {
  if (Object.hasOwn(EMOJI, name)) return EMOJI[name];
  const tone = SKIN_TONE.exec(name);
  if (tone) return SKIN_TONES[Number(tone[1]) - 2];
  const flag = FLAG.exec(name);
  if (flag) return [...flag[1]!].map((letter) => String.fromCodePoint(FLAG_A + letter.charCodeAt(0) - 97)).join("");
  return undefined;
}

// A name between colons that does not follow a letter or a digit, so the middle of
// "10:30:45" and of "host:port:path" is never taken for one.
const SHORTCODE = /(?<![A-Za-z0-9]):([a-z0-9_+'-]+):/g;

/**
 * A line of Slack text with its emoji shortcodes drawn: a standard one becomes its
 * character, and one of the workspace's own is left out, the words closing up around it.
 * A line that would be left empty is returned as it came.
 */
export function emojify(text: string): string {
  let dropped = false;
  const drawn = text.replace(SHORTCODE, (whole, name: string) => {
    const found = character(name);
    if (found !== undefined) return found;
    if (!/[a-z]/.test(name)) return whole; // ":30:" is a number between colons, not an emoji
    dropped = true;
    return "";
  });
  if (!dropped) return drawn;
  const tidy = drawn.replace(/\s{2,}/g, " ").trim();
  return tidy === "" ? text : tidy;
}
