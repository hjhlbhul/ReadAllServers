(function () {
    "use strict";
    // 모든서버읽기 v1.0.0 — Endcord Mobile 커뮤니티 플러그인 (Vendetta/Revenge 형식)
    // 서버 목록(GuildsBar) 맨 위에 버튼을 넣고, 누르면 모든 서버의 안 읽은 메시지·멘션을 읽음으로 표시해요.
    // 주의: 이 파일의 맨 첫 글자는 반드시 "(" 여야 합니다.

    var LABEL = "모든서버읽기";
    var SCAN_TIMES = [0, 800, 2000, 4000, 8000, 15000, 30000, 60000]; // 서버 목록을 찾아보는 시점(ms)

    var metro = vendetta.metro;
    var common = metro.common;
    var React = common.React;
    var RN = common.ReactNative;

    var unpatches = [];
    var patchedTargets = [];
    var timers = [];
    var unregisterCommand = null;
    var stopped = false;
    var cachedIcon;

    function store(name) {
        try { return metro.findByStoreName(name); } catch (e) { return null; }
    }

    function iconId() {
        if (cachedIcon !== undefined) return cachedIcon;
        cachedIcon = null;
        var names = ["CheckmarkLargeIcon", "CheckmarkSmallIcon", "ic_check_24px", "ic_check"];
        for (var i = 0; i < names.length; i++) {
            try {
                var id = vendetta.ui.assets.getAssetIDByName(names[i]);
                if (typeof id === "number") { cachedIcon = id; break; }
            } catch (e) { /* 다음 이름 */ }
        }
        return cachedIcon;
    }

    function toast(text) {
        try { vendetta.ui.toasts.showToast(text, iconId() || undefined); } catch (e) { /* 무시 */ }
    }

    /* ===== 모든 서버 읽음 처리 (Endcord 기본 ReadAllNotificationsButton과 같은 방식) ===== */
    function readAll() {
        var GuildStore = store("GuildStore");
        var ReadStateStore = store("ReadStateStore");
        var GuildChannelStore = store("GuildChannelStore");
        var Threads = store("ActiveJoinedThreadsStore");
        if (!GuildStore || !ReadStateStore || !GuildChannelStore) {
            throw new Error("디스코드 내부 저장소를 찾지 못했어요");
        }

        var guilds = GuildStore.getGuilds() || {};
        var channels = [];
        var seen = {};

        function add(id) {
            if (!id || seen[id]) return;
            seen[id] = true;
            var unread = ReadStateStore.hasUnread && ReadStateStore.hasUnread(id);
            var mentions = ReadStateStore.getMentionCount ? ReadStateStore.getMentionCount(id) : 0;
            if (unread || mentions > 0) {
                channels.push({ channelId: id, messageId: ReadStateStore.lastMessageId(id), readStateType: 0 });
            }
        }

        Object.keys(guilds).forEach(function (key) {
            var guild = guilds[key];
            var guildId = (guild && guild.id) || key;
            var all = GuildChannelStore.getChannels(guildId) || {};
            (all.SELECTABLE || []).concat(all.VOCAL || []).forEach(function (c) {
                add(c && c.channel && c.channel.id);
            });
            var threads = Threads && Threads.getActiveJoinedThreadsForGuild
                ? Threads.getActiveJoinedThreadsForGuild(guildId) || {} : {};
            Object.keys(threads).forEach(function (parentId) {
                var group = threads[parentId] || {};
                Object.keys(group).forEach(function (threadId) {
                    var t = group[threadId];
                    add(t && t.channel && t.channel.id);
                });
            });
        });

        if (channels.length) {
            common.FluxDispatcher.dispatch({ type: "BULK_ACK", context: "APP", channels: channels });
        }
        return channels.length;
    }

    function runReadAll() {
        var count;
        try {
            count = readAll();
        } catch (e) {
            toast("❌ 읽음 처리 실패: " + ((e && e.message) || e));
            return;
        }
        toast(count ? "✅ " + count + "개 채널을 읽음으로 표시했어요" : "👍 이미 모두 읽었어요");
    }

    /* ===== 서버 목록 위 버튼 ===== */
    function ReadAllButton() {
        var state = React.useState(false);
        var busy = state[0], setBusy = state[1];
        var icon = iconId();
        var h = React.createElement;

        function press() {
            if (busy) return;
            setBusy(true);
            runReadAll();
            setTimeout(function () { setBusy(false); }, 1500); // 연타 방지
        }

        return h(RN.View, { style: { alignItems: "center", paddingTop: 6, paddingBottom: 6 } },
            h(RN.TouchableOpacity, {
                accessibilityRole: "button",
                accessibilityLabel: LABEL,
                activeOpacity: 0.7,
                onPress: press,
                style: {
                    width: 48, height: 48, borderRadius: 16,
                    backgroundColor: busy ? "#3BA55C" : "#5865F2",
                    alignItems: "center", justifyContent: "center"
                }
            }, icon
                ? h(RN.Image, { source: icon, style: { width: 24, height: 24, tintColor: "#FFFFFF" } })
                : h(RN.Text, { style: { color: "#FFFFFF", fontSize: 22, fontWeight: "700" } }, "✓")
            ),
            h(RN.Text, {
                numberOfLines: 1,
                adjustsFontSizeToFit: true,
                style: { marginTop: 3, fontSize: 9, fontWeight: "600", color: "#949BA4", maxWidth: 68, textAlign: "center" }
            }, LABEL)
        );
    }

    /* ===== 서버 목록 컴포넌트(GuildsBar) 찾아서 패치 ===== */
    function nameOf(f) {
        try { return f.displayName || f.name || ""; } catch (e) { return ""; }
    }

    function visit(holder, key, out, depth) {
        if (!holder || depth > 4) return;
        var v;
        try { v = holder[key]; } catch (e) { return; }
        if (!v) return;
        if (typeof v === "function" && nameOf(v) === "GuildsBar") {
            out.push([holder, key]);
            return;
        }
        if (typeof v === "object") { // memo / forwardRef 껍데기 벗기기
            visit(v, "type", out, depth + 1);
            visit(v, "render", out, depth + 1);
        }
    }

    function targetsOf(obj, out) {
        if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return;
        visit(obj, "default", out, 0);
        visit(obj, "GuildsBar", out, 0);
        if (typeof obj === "object") {
            visit(obj, "type", out, 0);
            visit(obj, "render", out, 0);
        }
    }

    function looksLikeGuildsBar(m) {
        try {
            var out = [];
            targetsOf(m, out);
            return out.length > 0;
        } catch (e) {
            return false;
        }
    }

    function alreadyPatched(holder, key) {
        for (var i = 0; i < patchedTargets.length; i++) {
            if (patchedTargets[i][0] === holder && patchedTargets[i][1] === key) return true;
        }
        return false;
    }

    function patchTarget(holder, key) {
        if (alreadyPatched(holder, key)) return;
        var unpatch = vendetta.patcher.after(key, holder, function (args, res) {
            if (stopped || !res) return res;
            try {
                // 기존 서버 목록 위에 버튼을 얹은 세로 묶음으로 바꿔서 그리기
                return React.createElement(RN.View, { style: { flex: 1 } },
                    React.createElement(ReadAllButton, null),
                    res);
            } catch (e) {
                return res;
            }
        });
        patchedTargets.push([holder, key]);
        unpatches.push(unpatch);
    }

    // 이미 불러와진 모듈만 직접 훑어보기 (findAll이 못 찾을 때의 예비 방법)
    function eachLoadedModule(cb) {
        var mods = metro.modules;
        if (!mods) return;
        function handle(m) {
            try {
                if (!m || !m.isInitialized || m.hasError || !m.publicModule) return;
                cb(m.publicModule);
            } catch (e) { /* 무시 */ }
        }
        if (typeof Map !== "undefined" && mods instanceof Map) {
            mods.forEach(handle);
        } else {
            for (var id in mods) handle(mods[id]);
        }
    }

    function scan() {
        if (stopped) return;
        var found = [];
        try {
            (metro.findAll(looksLikeGuildsBar) || []).forEach(function (r) { targetsOf(r, found); });
        } catch (e) { /* 무시 */ }
        if (!found.length && !patchedTargets.length) {
            eachLoadedModule(function (pm) {
                visit(pm, "exports", found, 0);
                var ex = pm.exports;
                if (ex && typeof ex === "object") targetsOf(ex, found);
            });
        }
        for (var i = 0; i < found.length; i++) {
            try { patchTarget(found[i][0], found[i][1]); } catch (e) { /* 무시 */ }
        }
    }

    return {
        onLoad: function () {
            stopped = false;

            // 버튼이 안 보일 때를 위한 예비 명령어
            unregisterCommand = vendetta.commands.registerCommand({
                name: LABEL,
                displayName: LABEL,
                description: "모든 서버의 안 읽은 메시지와 멘션을 읽음으로 표시해요",
                displayDescription: "모든 서버의 안 읽은 메시지와 멘션을 읽음으로 표시해요",
                options: [],
                execute: function () { runReadAll(); }
            });

            SCAN_TIMES.forEach(function (ms, idx) {
                timers.push(setTimeout(function () {
                    scan();
                    if (idx === SCAN_TIMES.length - 1 && !patchedTargets.length && !stopped) {
                        toast("서버 목록을 찾지 못해 버튼을 못 달았어요. 대신 /" + LABEL + " 명령어를 써 주세요");
                    }
                }, ms));
            });
        },

        onUnload: function () {
            stopped = true;
            for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
            timers = [];
            for (var j = 0; j < unpatches.length; j++) {
                try { unpatches[j](); } catch (e) { /* 무시 */ }
            }
            unpatches = [];
            patchedTargets = [];
            if (unregisterCommand) {
                try { unregisterCommand(); } catch (e) { /* 무시 */ }
                unregisterCommand = null;
            }
        }
    };
})()
