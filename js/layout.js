/* layout.js — 파싱 데이터 + 옵션 → 렌더 블록 (미리보기·EPUB 공용)
 *
 * 블록 종류
 *  { type:'tabHeading', name, count }
 *  { type:'group', channelId, channelName|null, speaker, color, avatar, items:[{ text, roll, edited }] }
 *  { type:'system', channelName|null, text }
 */
(function (global) {
  'use strict';

  function item(m) {
    return { text: m.text, roll: m.roll, edited: m.edited };
  }

  function buildBlocks(data, opts) {
    var enabled = opts.enabledChannels;
    var nameOf = new Map();
    data.channels.forEach(function (c) { nameOf.set(c.id, c.name); });
    var active = data.channels.filter(function (c) { return enabled.has(c.id); });
    // 탭 라벨은 표시하지 않는다 (보조 스타일로 구분)
    var showLabel = false;
    var splitOnAvatar = !!(opts.merge && opts.mergeSplitOnAvatarChange && opts.showAvatar);
    var mutedSet = opts.mutedChannels || new Set();

    var blocks = [];
    var included = 0;
    var groups = 0;

    function emit(msgs) {
      var last = null;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        included++;
        var label = showLabel ? nameOf.get(m.channelId) : null;
        var muted = mutedSet.has(m.channelId);
        if (m.system) {
          blocks.push({ type: 'system', channelName: label, text: m.text, muted: muted });
          last = null;
          continue;
        }
        // 보조 탭은 전역 옵션과 무관하게 아이콘 없이, 항상 통합
        var avatar = muted ? null : m.avatar;
        var canMerge = (opts.merge || muted) && last &&
          last.channelId === m.channelId &&
          last.speaker === m.speaker &&
          (muted || !splitOnAvatar || last.avatar === m.avatar);
        if (canMerge) {
          last.items.push(item(m));
        } else {
          last = {
            type: 'group', channelId: m.channelId, channelName: label,
            speaker: m.speaker, color: m.color, avatar: avatar, muted: muted, items: [item(m)]
          };
          blocks.push(last);
          groups++;
        }
      }
    }

    if (opts.groupByTab) {
      active.forEach(function (c) {
        var msgs = data.messages.filter(function (m) { return m.channelId === c.id; });
        if (!msgs.length) return;
        blocks.push({ type: 'tabHeading', name: c.name, count: msgs.length });
        emit(msgs);
      });
    } else {
      emit(data.messages.filter(function (m) { return enabled.has(m.channelId); }));
    }

    return {
      blocks: blocks,
      stats: { included: included, excluded: data.messages.length - included, groups: groups, blocks: blocks.length }
    };
  }

  global.CcfoliaLayout = { buildBlocks: buildBlocks };
})(window);
