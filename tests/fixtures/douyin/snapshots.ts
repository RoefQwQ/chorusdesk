/**
 * Douyin fixtures.
 *
 * Derived from a real acquisition spike against a public creator profile
 * (2026-09, headed Chrome + CDP). The card shape, URL forms, signed-cover query
 * shape and the `"<nickname>：<caption>"` alt convention are reproduced exactly as
 * observed; the creator's name, ids and signature values are replaced with
 * synthetic equivalents so no real account or live signed URL is committed.
 *
 * The aweme ids are REAL ids kept intact on purpose: `publishedAtFromAwemeId`
 * depends on the snowflake layout, so substituting made-up numbers would make
 * the timestamp tests prove nothing.
 */

/** As returned by `collectDouyinSnapshot` for a normal video-only creator. */
export const videoSnapshot = {
  secUid: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  authorName: '示例创作者',
  authorAvatar:
    'https://p3-pc.douyinpic.com/img/aweme-avatar/tos-cn-avt-0015_synthetic~c5_300x300.jpeg?from=2956013662',
  pageUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  items: [
    {
      awemeId: '7679013756022962021',
      type: 'video' as const,
      href: '/video/7679013756022962021',
      description: '示例创作者：《我们这一家》第十四集！！！ \n是的，我们有一个孩纸\n#全民AI创作大赛#LibTV',
      coverUrl:
        'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/synthetic01~tplv-dy-cropcenter:323:430.jpeg?biz_tag=pcweb_cover&from=327834062&lk3s=138a59ce&s=PackSourceEnum_PUBLISH&sc=cover&se=true&sh=323_430&x-expires=2104329600&x-signature=SyntheticSignature01%3D',
      imageUrls: [] as string[],
    },
    {
      awemeId: '7675586375316758949',
      type: 'video' as const,
      href: '/video/7675586375316758949',
      description: '示例创作者：《我们这一家》第十三集！！！ \n七夕到了\n#创作阶梯计划',
      coverUrl:
        'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/synthetic02~tplv-dy-cropcenter:323:430.jpeg?biz_tag=pcweb_cover&x-expires=2104329600&x-signature=SyntheticSignature02%3D',
      imageUrls: [] as string[],
    },
    {
      awemeId: '7107964079427423525',
      type: 'video' as const,
      href: '/video/7107964079427423525?source=Baiduspider',
      description: '示例创作者：一条 2022 年的旧作品',
      coverUrl:
        'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/synthetic03~tplv-dy-cropcenter:323:430.jpeg?x-expires=2104329600&x-signature=SyntheticSignature03%3D',
      imageUrls: [] as string[],
    },
  ],
  gridError: false,
  requiresAuth: false,
  requiresVerify: false,
};

/** An image ("note") work, including a multi-image gallery with a duplicate. */
export const imageSnapshot = {
  secUid: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  authorName: '示例创作者',
  authorAvatar: '',
  pageUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  items: [
    {
      awemeId: '7589293158236871918',
      type: 'image' as const,
      href: '/note/7589293158236871918',
      description: '示例创作者：一组图文作品 #摄影 #日常',
      coverUrl:
        'https://p3-pc-sign.douyinpic.com/obj/synthetic-note-cover.jpeg?x-expires=2104329600&x-signature=NoteCover%3D',
      imageUrls: [
        'https://p3-pc-sign.douyinpic.com/obj/synthetic-note-1.jpeg?x-expires=2104329600&x-signature=Img1%3D',
        'https://p3-pc-sign.douyinpic.com/obj/synthetic-note-2.jpeg?x-expires=2104329600&x-signature=Img2%3D',
        // Exact duplicate of image 1 — the normalizer must collapse it.
        'https://p3-pc-sign.douyinpic.com/obj/synthetic-note-1.jpeg?x-expires=2104329600&x-signature=Img1%3D',
        'https://p3-pc-sign.douyinpic.com/obj/synthetic-note-3.jpeg?x-expires=2104329600&x-signature=Img3%3D',
      ],
    },
  ],
  gridError: false,
  requiresAuth: false,
  requiresVerify: false,
};

/** Degenerate cards: every one of these must be rejected or repaired. */
export const malformedSnapshot = {
  secUid: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  authorName: '示例创作者',
  authorAvatar: 'javascript:alert(1)',
  pageUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  items: [
    // No id anywhere → unidentifiable, must be dropped.
    { type: 'video', href: '/video/', description: '缺少作品 ID', coverUrl: '', imageUrls: [] },
    // Id too short to be a snowflake → dropped.
    { awemeId: '123', type: 'video', href: '/video/123', description: '非法 ID', coverUrl: '', imageUrls: [] },
    // Id that decodes to a pre-Douyin timestamp → dropped, never stored as epoch.
    { awemeId: '100000000000000001', type: 'video', href: '/video/100000000000000001', description: '时间戳异常', coverUrl: '', imageUrls: [] },
    // Valid id, but everything else missing/hostile: kept, with the bad cover and
    // the dangerous protocol stripped.
    {
      awemeId: '7638511271638600586',
      type: 'video',
      href: '/video/7638511271638600586',
      description: '',
      coverUrl: 'javascript:alert(1)',
      imageUrls: ['data:image/png;base64,AAA', 'https://evil.example/x.jpg', 'not a url'],
    },
    // Duplicate of the previous work → collapsed to one.
    {
      awemeId: '7638511271638600586',
      type: 'video',
      href: '/video/7638511271638600586',
      description: '重复作品',
      coverUrl: '',
      imageUrls: [],
    },
  ],
  gridError: false,
  requiresAuth: false,
  requiresVerify: false,
};

/** A creator with no works yet — a success with zero items, NOT an error. */
export const emptySnapshot = {
  secUid: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  authorName: '空作品创作者',
  authorAvatar: '',
  pageUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  items: [],
  gridError: false,
  requiresAuth: false,
  requiresVerify: false,
};

/**
 * A page whose markup changed so much that nothing parses. Distinguishable from
 * `emptySnapshot`: the page reported an explicit grid failure.
 */
export const driftedSnapshot = {
  secUid: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  authorName: '',
  authorAvatar: '',
  pageUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  // Fields renamed by a hypothetical Douyin redesign.
  items: [
    { id: '7679013756022962021', kind: 'short_video', link: '/v/7679013756022962021' },
    { id: '7675586375316758949', kind: 'short_video', link: '/v/7675586375316758949' },
  ],
  gridError: false,
  requiresAuth: false,
  requiresVerify: false,
};
