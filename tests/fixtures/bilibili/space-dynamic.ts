/**
 * Bilibili fixtures — captured live, then scrubbed down to the parsed paths.
 *
 * Source (2026-09-12):
 *
 *   GET https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=<uid>
 *
 * Why these exist: `bilibili.ts` is 435 lines of dense branching with ZERO tests,
 * and the plan for that is fixture → extract → assert the same fixture parses
 * identically. This is step one, and the only step that requires no change to the
 * adapter.
 *
 * They are PRUNED, not merely trimmed. The live responses carried 12 items of
 * ~100 keys each (many nested — `major` alone has 18 sub-modules: courses, live,
 * music, opus, pgc…). Keeping that shape while scrubbing every identity proved
 * error-prone: a first pass left a real user comment (`"翻得好！"`) and a dozen
 * live CDN URLs nested in modules the parser never reads. So each item now keeps
 * **only the paths `bilibili.ts` actually reads**, which makes the fixture small
 * (4 KB total), fully synthetic, and every remaining field intentional:
 *
 *   item.type · item.id_str · item.orig (recursively, `null` on non-forwards)
 *   item.basic.comment_id_str
 *   modules.module_author.{name, face, pub_ts}
 *   modules.module_dynamic.desc.text
 *   modules.module_dynamic.major.archive.{bvid, title, desc, cover}
 *   modules.module_dynamic.major.draw.items[].{src, width, height}
 *
 * Two consequences to know when reading assertions:
 *   - an EMPTY `major` is preserved as an empty object, because that is the
 *     meaningful shape of a FORWARD wrapper (the media lives on its `orig`);
 *   - `orig: null` is preserved rather than omitted, because that is what the real
 *     payload carries on non-forwards and `Boolean(item.orig)` is part of the
 *     adapter's `isForward` test.
 *
 * Everything identity-bearing is synthetic: ids are `7000…`, `name` is 示例UP主,
 * `bvid` is `BV1SYNTH…`, covers/faces point at `i0.hdslb.com/bfs/…synthetic…`,
 * and text is 示例/合成 strings. Each item's ids are unique, because a first pass
 * gave every item the same id and the adapter's own dedup then swallowed items —
 * the fixture would have hidden the behaviour it exists to pin.
 *
 * `data.has_more` and `data.offset` are the real values: the cursor is what the
 * history dig pages on.
 */

/** FORWARD ×2 (each with `orig`) + AV ×1 with `major.archive` — from bilibili's own account (uid 2), whose feed is the most forward-heavy available. */
export const spaceDynamicForwardHeavy: SpaceDynamicResponse = {
  "code": 0,
  "message": "0",
  "data": {
    "has_more": true,
    "offset": "1160055449596198920",
    "items": [
      {
        "type": "DYNAMIC_TYPE_FORWARD",
        "id_str": "70000000000000000",
        "orig": {
          "type": "DYNAMIC_TYPE_AV",
          "id_str": "70000000000000000",
          "orig": null,
          "basic": {
            "comment_id_str": "70000000000000000"
          },
          "modules": {
            "module_author": {
              "name": "示例UP主",
              "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
              "pub_ts": "1785898593"
            },
            "module_dynamic": {
              "major": {
                "archive": {
                  "bvid": "BV1SYNTH0000",
                  "title": "【示例】合成标题",
                  "desc": "合成简介",
                  "cover": "https://i0.hdslb.com/bfs/archive/synthetic_0000.jpg"
                },
                "draw": null
              }
            }
          }
        },
        "basic": {
          "comment_id_str": "70000000000000000"
        },
        "modules": {
          "module_author": {
            "name": "示例UP主",
            "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
            "pub_ts": "1786010959"
          },
          "module_dynamic": {
            "desc": {
              "text": "示例动态正文"
            },
            "major": {}
          }
        }
      },
      {
        "type": "DYNAMIC_TYPE_FORWARD",
        "id_str": "70000000000000001",
        "orig": {
          "type": "DYNAMIC_TYPE_AV",
          "id_str": "70000000000000001",
          "orig": null,
          "basic": {
            "comment_id_str": "70000000000000001"
          },
          "modules": {
            "module_author": {
              "name": "示例UP主",
              "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
              "pub_ts": "1784001616"
            },
            "module_dynamic": {
              "major": {
                "archive": {
                  "bvid": "BV1SYNTH0001",
                  "title": "【示例】合成标题",
                  "desc": "合成简介",
                  "cover": "https://i0.hdslb.com/bfs/archive/synthetic_0001.jpg"
                },
                "draw": null
              }
            }
          }
        },
        "basic": {
          "comment_id_str": "70000000000000001"
        },
        "modules": {
          "module_author": {
            "name": "示例UP主",
            "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
            "pub_ts": "1785914404"
          },
          "module_dynamic": {
            "desc": {
              "text": "示例动态正文"
            },
            "major": {}
          }
        }
      },
      {
        "type": "DYNAMIC_TYPE_AV",
        "id_str": "70000000000000002",
        "orig": null,
        "basic": {
          "comment_id_str": "70000000000000002"
        },
        "modules": {
          "module_author": {
            "name": "示例UP主",
            "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
            "pub_ts": "1783878096"
          },
          "module_dynamic": {
            "major": {
              "archive": {
                "bvid": "BV1SYNTH0002",
                "title": "【示例】合成标题",
                "desc": "合成简介",
                "cover": "https://i0.hdslb.com/bfs/archive/synthetic_0002.jpg"
              },
              "draw": null
            }
          }
        }
      }
    ]
  }
};

/** DRAW ×2 with `major.draw.items[]` — from a public creator whose feed is all image posts. Note `archive: null` on these: DRAW items carry the key but no value, and the adapter relies on that being falsy. */
export const spaceDynamicDraw: SpaceDynamicResponse = {
  "code": 0,
  "message": "0",
  "data": {
    "has_more": true,
    "offset": "1226515833691308041",
    "items": [
      {
        "type": "DYNAMIC_TYPE_DRAW",
        "id_str": "70000000000000000",
        "orig": null,
        "basic": {
          "comment_id_str": "70000000000000000"
        },
        "modules": {
          "module_author": {
            "name": "示例UP主",
            "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
            "pub_ts": "1786538042"
          },
          "module_dynamic": {
            "major": {
              "archive": null,
              "draw": {
                "items": [
                  {
                    "src": "https://i0.hdslb.com/bfs/new_dyn/synthetic_0000_0.jpg",
                    "width": 1200,
                    "height": 1600
                  }
                ]
              }
            }
          }
        }
      },
      {
        "type": "DYNAMIC_TYPE_DRAW",
        "id_str": "70000000000000001",
        "orig": null,
        "basic": {
          "comment_id_str": "70000000000000001"
        },
        "modules": {
          "module_author": {
            "name": "示例UP主",
            "face": "https://i0.hdslb.com/bfs/face/synthetic_face.jpg",
            "pub_ts": "1784503820"
          },
          "module_dynamic": {
            "major": {
              "archive": null,
              "draw": {
                "items": [
                  {
                    "src": "https://i0.hdslb.com/bfs/new_dyn/synthetic_0001_0.jpg",
                    "width": 1200,
                    "height": 1600
                  },
                  {
                    "src": "https://i0.hdslb.com/bfs/new_dyn/synthetic_0001_1.jpg",
                    "width": 1200,
                    "height": 1600
                  }
                ]
              }
            }
          }
        }
      }
    ]
  }
};

