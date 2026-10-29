/* 思源笔记 iPad「随手写」（Scribble）空块无法输入 —— JS 代码片段修复
 *
 * 用法：设置 → 外观 → 代码片段 → JS → 新建，粘贴本文件全部内容并启用，
 *      然后在代码片段面板点「重新加载」（或重启思源）。
 *
 * 原因：随手写要把笔迹转换进「已有文本节点 + 光标」的可编辑区域。新建的空段落
 *      只有 contenteditable 容器、没有文本节点，笔尖落下时随手写拿不到插入点，
 *      所以写不出字；先用键盘敲一个字就有了文本节点，于是恢复正常。
 *
 * 本片段在 iPad 上做的事：
 *   1. 光标进入空段落/空标题（点按、回车新建、键盘聚焦）时，在可编辑容器里放一个
 *      零宽空格（U+200B）文本节点作为书写锚点，并把光标放进这个文本节点；
 *   2. 笔尖按下空块时补锚点并聚焦，抢在思源的触摸光标逻辑之前；
 *   3. 块已经在编辑状态时绝不再动光标——手写两笔之间文字可能还没提交，此时重置
 *      光标会把后写的字插到前一个字前面（就是「你好」变「好你」的原因）；
 *   4. 文字真正插入前（beforeinput / 输入法开始 / 按键）先清掉零宽空格，此时还
 *      没有待提交的标记文本，不会打乱输入顺序；失焦后再删掉残留的空节点。
 */
(function () {
    "use strict";

    // 防止代码片段被重复注入
    if (window.__syIpadScribbleFix) {
        return;
    }
    window.__syIpadScribbleFix = true;

    // 只在 iPad 上生效（iPadOS 13+ 的 UA 是 Macintosh，需要靠触点数区分）
    const isIPad = /iPad/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!isIPad) {
        return;
    }

    const ZWSP = "\u200b";
    const BLOCK_SELECTOR =
        '[data-node-id][data-type="NodeParagraph"], [data-node-id][data-type="NodeHeading"]';
    const HOST_SELECTOR = ":scope > [contenteditable]:not(.protyle-attr)";
    // 有这些内容时虽然文本为空，但不是普通的空段落，不处理
    const SKIP_CONTENT_SELECTOR = "img, video, audio, iframe, .render-node, [data-node-id]";
    const SKIP_TARGET_SELECTOR =
        ".protyle-attr, .protyle-action, .table, .av, .protyle-title, button, a, input, textarea, select";

    // 注入过的节点：带零宽空格的锚点，以及清空后仍留在 DOM 里的空文本节点
    const injected = new Set();
    let composing = false;

    const getHost = (block) => {
        const host = block.querySelector(HOST_SELECTOR);
        return host && host.getAttribute("contenteditable") === "true" ? host : null;
    };

    const isBlank = (host) => {
        if (!host || host.querySelector(SKIP_CONTENT_SELECTOR)) {
            return false;
        }
        return host.textContent.replaceAll(ZWSP, "").trim() === "";
    };

    const caretStart = () => {
        const selection = window.getSelection();
        return selection && selection.rangeCount ? selection.getRangeAt(0).startContainer : null;
    };

    const ensureAnchor = (host) => {
        for (const child of host.childNodes) {
            if (child.nodeType === Node.TEXT_NODE && child.data.includes(ZWSP)) {
                return child;
            }
        }
        const node = document.createTextNode(ZWSP);
        host.appendChild(node);
        injected.add(node);
        return node;
    };

    const placeCaret = (host, node) => {
        if (document.activeElement !== host) {
            host.focus({preventScroll: true});
        }
        const selection = window.getSelection();
        if (!selection) {
            return;
        }
        const range = document.createRange();
        range.setStart(node, 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    };

    // 只给「还没有可编辑光标」的空块补锚点；正在编辑就绝不打断
    const prepareBlock = (target) => {
        if (!(target instanceof Element) || target.closest(SKIP_TARGET_SELECTOR)) {
            return;
        }
        const block = target.closest(BLOCK_SELECTOR);
        if (!block || !block.closest(".protyle-wysiwyg")) {
            return;
        }
        const host = getHost(block);
        if (!isBlank(host)) {
            return;
        }
        const node = ensureAnchor(host);
        if (!node) {
            return;
        }
        const start = caretStart();
        // 光标已经在块内的文本节点 / 输入法标记文本里，说明正在书写，保持原位
        if (start && start !== host && block.contains(start)) {
            return;
        }
        placeCaret(host, node);
    };

    // 清掉注入节点里的零宽空格。节点本身保留：空文本节点依然是合法的书写插入点，
    // 删节点会让系统把光标重新挪到容器开头，后写的字就会跑到前一个字前面。
    const release = (node) => {
        if (!node.isConnected) {
            injected.delete(node);
            return;
        }
        if (node.data.includes(ZWSP)) {
            node.data = node.data.replaceAll(ZWSP, "");
        }
        if (node.data !== "") {
            injected.delete(node);
        }
    };

    const releaseAll = () => {
        injected.forEach(release);
    };

    // 失焦后清理残留的空节点，恢复思源原本的空块 DOM（占位提示依赖 :empty）
    const purge = () => {
        injected.forEach((node) => {
            if (!node.isConnected) {
                injected.delete(node);
                return;
            }
            const host = node.parentElement;
            const block = host && host.closest(BLOCK_SELECTOR);
            if (!host || !block) {
                injected.delete(node);
                return;
            }
            const active = document.activeElement;
            if (active && (block.contains(active) ||
                (active.closest && active.closest(".protyle-wysiwyg") === active))) {
                return;
            }
            const selection = window.getSelection();
            if (selection && selection.rangeCount &&
                block.contains(selection.getRangeAt(0).startContainer)) {
                return;
            }
            if (node.data.replaceAll(ZWSP, "") !== "") {
                node.data = node.data.replaceAll(ZWSP, "");
            } else {
                node.remove();
            }
            injected.delete(node);
        });
    };

    // 1. 笔尖按下空块：补锚点并把光标放进锚点
    document.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "pen" || event.pointerType === "mouse") {
            prepareBlock(event.target);
        }
    }, true);

    // 部分 iPadOS 版本对笔只派发 touch 事件，用接触面积/压力识别笔尖
    document.addEventListener("touchstart", (event) => {
        const touch = event.touches && event.touches[0];
        if (!touch) {
            return;
        }
        const isStylus = touch.touchType === "stylus" ||
            (typeof touch.radiusX === "number" && touch.radiusX > 0 && touch.radiusX <= 3 &&
                typeof touch.force === "number" && touch.force > 0);
        if (isStylus) {
            prepareBlock(event.target);
        }
    }, {capture: true, passive: true});

    // 块被聚焦（点按空行、回车新建、随手写聚焦）时补锚点
    document.addEventListener("focusin", (event) => {
        prepareBlock(event.target);
    }, true);

    // 2. 光标进入空块且仍停在容器上时，把它移进锚点
    document.addEventListener("selectionchange", () => {
        if (composing) {
            return;
        }
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return;
        }
        const start = selection.getRangeAt(0).startContainer;
        if (start.nodeType === Node.TEXT_NODE) {
            return;
        }
        const element = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
        if (!element || !element.closest(".protyle-wysiwyg")) {
            return;
        }
        const block = element.closest(BLOCK_SELECTOR);
        if (!block || !block.contains(start)) {
            return;
        }
        // 焦点可能落在 .protyle-wysiwyg 或块内的编辑容器上
        const active = document.activeElement;
        if (!active || !active.closest || !active.closest(".protyle-wysiwyg")) {
            return;
        }
        const host = getHost(block);
        if (!isBlank(host)) {
            return;
        }
        const node = ensureAnchor(host);
        if (node) {
            placeCaret(host, node);
        }
    });

    // 3. 文字插入之前清掉零宽空格：此时系统还没有待提交的标记文本，不会打乱顺序
    document.addEventListener("beforeinput", () => {
        releaseAll();
    }, true);

    document.addEventListener("compositionstart", () => {
        composing = true;
        releaseAll();
    }, true);
    document.addEventListener("compositionend", () => {
        composing = false;
    }, true);

    // 兜底：老版本 Safari 没有 beforeinput，输入结束后再异步清理（不在事件派发中改 DOM）
    document.addEventListener("input", (event) => {
        if (event.isComposing) {
            return;
        }
        setTimeout(() => {
            injected.forEach((node) => {
                if (!node.isConnected) {
                    injected.delete(node);
                    return;
                }
                const host = node.parentElement;
                if (!host || !host.closest(".protyle-wysiwyg")) {
                    injected.delete(node);
                    return;
                }
                if (host.textContent.replaceAll(ZWSP, "").trim() === "") {
                    return;
                }
                release(node);
            });
        }, 0);
    }, true);

    // 4. 键盘操作前清掉零宽空格，保持思源原有的空块合并、斜杠菜单等行为
    document.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" || event.key === "Delete" || event.key.length === 1) {
            releaseAll();
        }
    }, true);

    document.addEventListener("focusout", () => {
        setTimeout(purge, 0);
    }, true);
})();
