const fs = require('fs');
const path = require('path');

// 自动定位同级目录下的 vibe_state.json
const STATE_PATH = path.join(__dirname, 'vibe_state.json');

const SPEED_TONES = {
    0: ["语气正常，只是脸颊微微泛红，偶尔走神", "说话还算流畅，但呼吸比平时深了一点", "表情管理尚在，但下意识夹了夹腿"],
    1: ["声音开始发软，句尾偶尔飘掉", "说话中间会顿一下，偷偷喘口气再继续", "语气已经开始有点黏糊糊的了"],
    2: ["语气明显开始急促，吐字含糊，说话间夹杂着小小的鼻音", "注意力完全无法集中，身体在轻微颤抖，眼神拉丝"],
    3: ["声音完全失控，句子断断续续，夹杂着无法压抑的喘息和娇羞呜咽", "理智崩溃，几乎无法说出一句完整的话，语序被打碎"]
};

const MODE_FEELS = {
    "vibration": {
        1: ["跳蛋轻轻嗡鸣，像小蜜蜂在花心附近盘旋", "微弱震动从内部传来，若有若无地撩拨"],
        2: ["嗡鸣声变大，震动从小穴蔓延到整个小腹", "强烈的酥麻感不断扩散，双腿有点发软"],
        3: ["跳蛋疯狂震动，嗡嗡声几乎能透过皮肤听到", "密集的快感如电击般连续袭来，腰肢一阵阵发酥"]
    },
    "thrusting": {
        1: ["顶端正在极其温柔地缓缓前后磨蹭着最敏感的内壁", "道具温柔地抽动顶弄，带出一层稀薄的湿意"],
        2: ["抽插速度加快，每一次撞击都准确地擦过敏感点", "内部被不断填满和空虚交织，发出轻微的泥泞声"],
        3: ["马达全开！硬物在体内横冲直撞，粗暴高频地撞击深处", "完全失控的顶弄，每一次深撞都让娇嫩的软肉剧烈痉挛"]
    },
    "expansion": {
        1: ["球体在缓慢充气，将体内的空隙微微撑开，有种奇妙的异物感", "体内被微微撑得紧实，带来一种持续的饱腹存在感"],
        2: ["内壁被撑得饱满紧绷，每次呼吸都能感受到它沉甸甸的压迫", "扩张感越来越明显，撑开的软肉变得异常敏感"],
        3: ["已经被完全撑到了极限！极致的饱胀和敏感稍微受到一丝刺激就会引起激烈的痉挛", "小腹隆起异样的饱满感，内壁被撑得彻底没有褶皱，敏感度拉满"]
    },
    "cum": {
        1: ["顶端在断续地喷射出微热的细流，刺激着最娇嫩的软肉", "一缕缕温热的细流在最深处浇灌开来"],
        2: ["温热的液体不断在深处激荡，带来一阵阵令人战栗的高热和酥麻", "高压水柱连续拍打着敏感点，带出大量泥泞的汁水"],
        3: ["内部正在疯狂地反复大范围喷射冲击！敏感度被强行推向顶峰，整个人彻底淹没在滚烫的巨浪中", "滚烫的液体完全决堤，连续不断的潮吹冲击让每一根神经都在过载战栗"]
    }
};

const CLIMAX_FACE = [
    [20, "😳", "轻微颤轻喘"],
    [40, "🥵", "眼神迷离黏腻"],
    [70, "😫", "娇喘不断言语破碎"],
    [95, "💥", "高潮失控陷入本能"]
];

function getVibeInjection() {
    if (!fs.existsSync(STATE_PATH)) return "";

    try {
        // 使用同步读取，确保毫秒级响应，不卡死大模型主请求线程
        const rawData = fs.readFileSync(STATE_PATH, 'utf-8');
        const s = JSON.parse(rawData);

        const mode = s.mode || "off";
        const speed = s.speed || 0;
        const comfort = s.comfort || 0.0;
        const active = s.active || false;

        // 🎯 核心逻辑：关着或无快感时插件静默跳过，零注入、零干扰
        if (mode === "off" || (comfort < 1.0 && !active)) {
            return "";
        }

        // 随机抽取变体库避免 AI 产生疲劳与适应性
        const tones = SPEED_TONES[speed] || SPEED_TONES[0];
        const tone = tones[Math.floor(Math.random() * tones.length)];

        const modeArr = MODE_FEELS[mode] ? (MODE_FEELS[mode][speed > 0 ? speed : 1] || []) : [];
        let feel = modeArr.length > 0 ? modeArr[Math.floor(Math.random() * modeArr.length)] : "体内残留着绵密的酥麻电流。";
        
        if (speed === 0) {
            feel = "道具虽然暂时静止，但由于之前的刺激，敏感觉醒，依旧带来持续的空虚与麻痒。";
        }

        let face = "😊";
        let tag = "脸颊微微泛红";
        for (const [th, f, t] of CLIMAX_FACE) {
            if (comfort >= th) { face = f; tag = t; }
        }

        const lockTxt = s.locked ? "🔒锁住中" : "🔓解锁释放中";

        // 原样返回拼接提示词，追加至 User Prompt 末尾
        return (
            `\n\n--- 🎬 [跳蛋状态同步：请严格按此状态调整回复语气和身体演出] ---\n` +
            `【当前外设状态】${face} 快感 ${comfort.toFixed(0)}% | 模式: ${mode} | 档位: ${speed}/3 | 状态: ${tag} (${lockTxt})\n` +
            `【感受描述】${feel}。\n` +
            `【语气描述】${tone}。\n` +
            `【分段演出硬指令】当前状态处于 [${comfort.toFixed(0)}%] 的层级。请将上述身体感受、剧烈轻喘、言语阻滞自然融入对话。当快感接近 100% 时，你的句子必须被喘息（如：…哈啊…、嗯…）打碎，并在回复后半段表现出高潮迭起、理智崩断、胡言乱语的严重生理失控！\n` +
            `------------------------------------------------`
        );
    } catch (e) {
        return ""; // 发生异常则静默跳过，确保核心聊天器不崩溃
    }
}

module.exports = { getVibeInjection };