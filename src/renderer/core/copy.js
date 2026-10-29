/**
 * 台词库。纯数据 + 确定性选句，方便单元测试。
 * 语气要求：可爱、调皮、有点中二，但不冒犯、不制造焦虑。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  const LINES = {
    greet: [
      '今天准备先搞定哪件事？',
      '我在桌面上蹲好了，随时开工。',
      '要先写一个任务，还是直接开始专注？',
      '今天也一起把进度条推一格吧。'
    ],
    idle: [
      '待机中，等你派活。',
      '我先发会儿呆，你忙你的。',
      '任务面板在右键菜单里，别找了。',
      '要不要先定个 25 分钟？',
      '桌面这么干净，说明快干活了。'
    ],
    focusStart: [
      '专注模式启动，我盯着你呢。',
      '接下来这段时间，只有你和任务。',
      '倒计时开始，摸鱼会被我发现的。',
      '我已经把大刀收起来了，先认真一会儿。'
    ],
    focusTick: [
      '还在打，稳住。',
      '别切窗口，就快好了。',
      '进度条在动，我也在动。',
      '呼吸，继续。'
    ],
    focusDone: [
      '专注时间结束啦，要不要检查一下进度？',
      '铃响了，看看刚才做完了多少。',
      '这一轮结束了，战果如何？',
      '时间到，该验收成果了。'
    ],
    break: [
      '起来走两步吧。',
      '喝口水，回来继续。',
      '看看远处，让眼睛休息一下。',
      '肩膀是不是已经僵了？动一动。',
      '站起来伸个懒腰，我替你看着屏幕。'
    ],
    celebrate: [
      '全部完成！今天的你值得一朵小红花。',
      '任务清空，今日份的你已经很强了。',
      '收工！这种时候就该被夸。',
      '清单见底，我给你放个烟花。'
    ],
    celebratePartial: [
      '搞定一件，进度条又走了一格。',
      '漂亮，这一条划掉得干脆。',
      '又少一个，继续。'
    ],
    caught: [
      '抓到你了！',
      '摸鱼证据确凿，吃我一刀！',
      '我看见了，你刚才在划水。',
      '别装了，屏幕不会说谎。'
    ],
    taunt: [
      '再拖一会儿，任务也不会自己消失。',
      '我不催你，我只是站在这儿看着。',
      '这个任务已经在清单里坐了一整天了。',
      '要不先做两分钟？两分钟不算开始。',
      '你可以选择现在做，也可以选择待会儿后悔。'
    ],
    companion: [
      '我在，你说。',
      '陪你待会儿，不说话也行。',
      '需要我讲个冷笑话吗？',
      '今天感觉怎么样？'
    ],
    emptyTasks: [
      '今天还没有添加任务。',
      '清单是空的，先写一件小事？',
      '没有任务不代表没有事，要不要记一条？'
    ],
    dnd: [
      '免打扰已开启，我先闭嘴。',
      '不吵你，需要我时右键叫我。',
      '安静模式，我蹲在角落。'
    ]
  };

  const JOKES = [
    '为什么程序员分不清万圣节和圣诞节？因为 Oct 31 等于 Dec 25。',
    '我本来想减肥，结果只减掉了计划的第 3 条。',
    '有个人把待办写成了待想，然后就没有然后了。',
    '我朋友说他今天一定要早睡，说完看了三集剧。',
    '为什么番茄钟不会累？因为它只会转圈。'
  ];

  const PRAISE = [
    '你刚才那一下，效率高得像开了挂。',
    '这件事你做得比你以为的好。',
    '稳，这就是专业选手的手感。',
    '继续保持，我记你一功。',
    '今天的你已经比昨天多走了半步。'
  ];

  /**
   * 确定性选句：同样的 seed 得到同一句，便于测试与“不要连续重复”。
   * @param {string} poolName
   * @param {number} seed
   */
  function pick(poolName, seed) {
    const pool = LINES[poolName];
    if (!Array.isArray(pool) || pool.length === 0) return '';
    return util.pickByIndex(pool, seed);
  }

  /** 从池中挑一句，尽量避开上一句 */
  function pickAvoiding(poolName, seed, previous) {
    const pool = LINES[poolName];
    if (!Array.isArray(pool) || pool.length === 0) return '';
    if (pool.length === 1) return pool[0];
    let line = util.pickByIndex(pool, seed);
    if (line === previous) {
      line = util.pickByIndex(pool, seed + 1);
    }
    return line;
  }

  function joke(seed) {
    return util.pickByIndex(JOKES, seed) || '';
  }

  function praise(seed) {
    return util.pickByIndex(PRAISE, seed) || '';
  }

  const api = {
    LINES,
    JOKES,
    PRAISE,
    pick,
    pickAvoiding,
    joke,
    praise
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.copy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
