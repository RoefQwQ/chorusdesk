/**
 * Xiaohongshu fixtures — captured live, then pruned to the parsed paths.
 *
 * Source (2026-09-12): the profile page the adapter itself fetches,
 *   GET https://www.xiaohongshu.com/user/profile/<userId>
 * whose SSR embeds `window.__INITIAL_STATE__`. The adapter reads the notes out of
 * that state, so this fixture is the **state**, and the test wraps it in the HTML
 * envelope the adapter's regex expects.
 *
 * Why: `xiaohongshu.ts` is ~390 lines of nested-record reading with ZERO tests, and
 * the previously-shipped bug in exactly this shape was dead fallback code
 * (`asRecord(item.noteCard) || item` — an empty record is truthy, so the right-hand
 * side never ran).
 *
 * PRUNED, not merely trimmed, following the bilibili fixture: the live state has
 * ~30 notes of ~20 keys each (plus a `noteCard.cover` carrying seven). Each note
 * here keeps only what the adapter reads — `id`, `noteCard.{noteId, displayTitle,
 * type, time, interactInfo.likedCount, cover.{urlDefault, urlPre, infoList[0].url}}`
 * — and `user.userPageData.basicInfo` for the author. That makes it 1.5 KB, fully
 * synthetic, and every field intentional.
 *
 * Two shapes are deliberately faithful because the adapter depends on them:
 *   - **nested notes array** (`notes: [[…]]`): real pages nest one level and the
 *     adapter flattens `Array.isArray(item)` before reading a card;
 *   - **24-hex note ids**: the adapter derives `publishedAt` from the first 8 hex
 *     characters when a card carries no `time`, and the detail-enrichment filter
 *     tests `/^[0-9a-f]{24}$/`. Synthetic ids keep that shape.
 *
 * Everything identity-bearing is synthetic: `redId`/`nickname`, avatar and cover
 * URLs (`sns-img-qc.xhscdn.com/synthetic_*`), titles (`示例笔记标题N`), counts.
 *
 * NOT reproduced: real SSR HTML writes bare `undefined` tokens, which the adapter
 * cleans with `: undefined -> : null`. The `undefined` path has its own test case
 * with a hand-written envelope, because `JSON.stringify` cannot produce it.
 */

/** The `window.__INITIAL_STATE__` object of a creator's profile page. */
export const profileInitialState = {
  "user": {
    "userPageData": {
      "basicInfo": {
        "redId": "synthetic0001",
        "nickname": "示例博主",
        "desc": "合成简介",
        "imageb": "https://sns-avatar-qc.xhscdn.com/synthetic_avatar.jpg",
        "images": "https://sns-avatar-qc.xhscdn.com/synthetic_avatar.jpg",
        "ipLocation": "示例"
      }
    },
    "notes": [
      [
        {
          "id": "6a0000020000000025037c02",
          "noteCard": {
            "noteId": "6a0000020000000025037c02",
            "displayTitle": "示例笔记标题0",
            "type": "normal",
            "time": 1778384898000,
            "interactInfo": {
              "likedCount": "100"
            },
            "cover": {
              "urlDefault": "https://sns-img-qc.xhscdn.com/synthetic_0000.jpg",
              "urlPre": "https://sns-img-qc.xhscdn.com/synthetic_0000_pre.jpg",
              "infoList": [
                {
                  "url": "https://sns-img-qc.xhscdn.com/synthetic_0000_info.jpg"
                }
              ]
            }
          }
        },
        {
          "id": "6a0000010000000025037c01",
          "noteCard": {
            "noteId": "6a0000010000000025037c01",
            "displayTitle": "示例笔记标题1",
            "type": "normal",
            "time": 1778384897000,
            "interactInfo": {
              "likedCount": "101"
            },
            "cover": {
              "urlDefault": "https://sns-img-qc.xhscdn.com/synthetic_0001.jpg",
              "urlPre": "https://sns-img-qc.xhscdn.com/synthetic_0001_pre.jpg",
              "infoList": [
                {
                  "url": "https://sns-img-qc.xhscdn.com/synthetic_0001_info.jpg"
                }
              ]
            }
          }
        },
        {
          "id": "6a0000000000000025037c00",
          "noteCard": {
            "noteId": "6a0000000000000025037c00",
            "displayTitle": "示例笔记标题2",
            "type": "normal",
            "time": 1778384896000,
            "interactInfo": {
              "likedCount": "102"
            },
            "cover": {
              "urlDefault": "https://sns-img-qc.xhscdn.com/synthetic_0002.jpg",
              "urlPre": "https://sns-img-qc.xhscdn.com/synthetic_0002_pre.jpg",
              "infoList": [
                {
                  "url": "https://sns-img-qc.xhscdn.com/synthetic_0002_info.jpg"
                }
              ]
            }
          }
        }
      ]
    ]
  }
} as const;
