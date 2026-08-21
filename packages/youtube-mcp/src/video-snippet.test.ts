import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildUpdatedSnippet, MAX_DESCRIPTION_LENGTH } from "./video-snippet.js";

// The fixture is captured (with identifying values replaced by placeholders)
// from a real videos.list(part=snippet,status,localizations) response, so
// this test exercises the actual shape the API returns, not a hand-guessed
// one. It lives under src/ (not dist/) even though this compiled test runs
// from dist/, since tsc only compiles .ts files and leaves the JSON fixture
// where it is.
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "src", "__fixtures__", "videos-list-response.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const originalSnippet = fixture.items[0].snippet;

test("buildUpdatedSnippet changes only description; every other field is preserved verbatim", () => {
  const newDescription = "Brand new description text, replacing the old one entirely.";
  const updated = buildUpdatedSnippet(originalSnippet, newDescription);

  // The thing that must change.
  assert.equal(updated.description, newDescription);
  assert.notEqual(updated.description, originalSnippet.description);

  // The things that must NOT change — this is the assertion that matters.
  // A test that only checks the description changed would pass even if the
  // merge silently dropped title/categoryId/tags/defaultLanguage.
  assert.equal(updated.title, originalSnippet.title);
  assert.equal(updated.categoryId, originalSnippet.categoryId);
  assert.deepEqual(updated.tags, originalSnippet.tags);
  assert.equal(updated.defaultLanguage, originalSnippet.defaultLanguage);
  assert.equal(updated.defaultAudioLanguage, originalSnippet.defaultAudioLanguage);
  assert.equal(updated.channelId, originalSnippet.channelId);
  assert.equal(updated.channelTitle, originalSnippet.channelTitle);
  assert.equal(updated.publishedAt, originalSnippet.publishedAt);
  assert.deepEqual(updated.thumbnails, originalSnippet.thumbnails);
  assert.deepEqual(updated.localized, originalSnippet.localized);
});

test("buildUpdatedSnippet does not mutate its input", () => {
  const before = JSON.parse(JSON.stringify(originalSnippet));
  buildUpdatedSnippet(originalSnippet, "some other new description");
  assert.deepEqual(originalSnippet, before);
});

test("buildUpdatedSnippet works when the original snippet has no tags array (real videos can lack one)", () => {
  const noTagsSnippet = { ...originalSnippet, tags: undefined };
  const updated = buildUpdatedSnippet(noTagsSnippet, "new description");
  assert.equal(updated.tags, undefined);
  assert.equal(updated.title, originalSnippet.title);
});

test("MAX_DESCRIPTION_LENGTH matches YouTube's documented cap", () => {
  assert.equal(MAX_DESCRIPTION_LENGTH, 5000);
});
