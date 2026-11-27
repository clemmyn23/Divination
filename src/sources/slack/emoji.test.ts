import assert from "node:assert/strict";
import { test } from "node:test";
import { emojify } from "./emoji.ts";

test("a standard shortcode becomes its emoji", () => {
  assert.equal(emojify(":wave: hi all"), "👋 hi all");
  assert.equal(emojify(":loudspeaker: Release at 3"), "📢 Release at 3");
  assert.equal(emojify("Thanks :slightly_smiling_face:"), "Thanks 🙂");
  assert.equal(emojify(":red_circle: Triggered: queue depth"), "🔴 Triggered: queue depth");
  assert.equal(emojify("Looks good :+1: :white_check_mark:"), "Looks good 👍 ✅");
  assert.equal(emojify("done:tada:"), "done:tada:"); // glued to a word: not a shortcode
  assert.equal(emojify(":tada::rocket:"), "🎉🚀");
});

test("a skin tone and a flag are worked out, not looked up", () => {
  assert.equal(emojify(":wave::skin-tone-3: hello"), "👋🏼 hello");
  assert.equal(emojify("Back in :flag-au: Monday"), "Back in 🇦🇺 Monday");
});

test("a workspace's own emoji has no character, so it is left out and the words close up", () => {
  assert.equal(emojify("Deploy is out :partyparrot:"), "Deploy is out");
  assert.equal(emojify("Thanks :takeabow: for the review"), "Thanks for the review");
  assert.equal(emojify(":shipit-squirrel: Approved, go ahead"), "Approved, go ahead");
  // Nothing else to show: the name stays, so the line is not blank.
  assert.equal(emojify(":partyparrot:"), ":partyparrot:");
  assert.equal(emojify(":partyparrot: :takeabow:"), ":partyparrot: :takeabow:");
});

test("colons that are not shortcodes are left alone", () => {
  assert.equal(emojify("Standup moved to 10:30:45 today"), "Standup moved to 10:30:45 today");
  assert.equal(emojify("ratio is 1:2:3"), "ratio is 1:2:3");
  assert.equal(emojify("see host:port:path"), "see host:port:path");
  assert.equal(emojify("at :30: past"), "at :30: past"); // a number alone is not a custom emoji
  assert.equal(emojify("Note: this: that"), "Note: this: that");
  assert.equal(emojify(""), "");
  assert.equal(emojify(":constructor: :__proto__: ok"), "ok"); // names every object has are not in the table
});
