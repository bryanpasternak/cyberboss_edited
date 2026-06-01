import tkinter as tk
from tkinter import ttk
import json
import time
import os

# 状态文件绝对路径
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vibe_state.json")

class VibeControllerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("弥亚的小跳蛋")
        self.root.geometry("320x460")
        self.root.configure(bg="#FFF0F5")  # 粉色背景
        self.root.resizable(False, False)

        self.init_state_file()

        # 配置进度条样式
        self.style = ttk.Style()
        self.style.configure("TProgressbar", thickness=20)

        self.create_widgets()

        # 启动核心双循环
        self.tick()        
        self.refresh_ui()  

    def init_state_file(self):
        if not os.path.exists(STATE_PATH):
            default_state = {
                "mode": "off",
                "speed": 0,
                "comfort": 0.0,
                "locked": False,
                "active": False,
                "lastTick": time.time()
            }
            self.write_state(default_state)

    def read_state(self):
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return {"mode": "off", "speed": 0, "comfort": 0.0, "locked": False, "active": False, "lastTick": time.time()}

    def write_state(self, state):
        try:
            with open(STATE_PATH, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=4, ensure_ascii=False)
        except:
            pass

    def create_widgets(self):
        # 标题 (使用老款 Tcl 支持的复古心形符号)
        title = tk.Label(self.root, text="♥ 弥亚的小跳蛋 ♥", font=("Helvetica", 14, "bold"), bg="#FFF0F5", fg="#DB7093")
        title.pack(pady=15)

        # ---- 模式选择区域 ----
        mode_frame = tk.LabelFrame(self.root, text=" 刻度 模式选择 ", bg="#FFF0F5", fg="#DB7093", font=("Helvetica", 10))
        mode_frame.pack(fill="x", padx=20, pady=5)

        # 彻底移除 4 字节 Emoji，改用标准的 Tcl/Tk 安全符号
        modes = [("○ 关", "off"), ("♥ 振动", "vibration"), ("▲ 抽插", "thrusting"), ("◆ 扩张", "expansion"), ("◆ 潮吹", "cum")]
        self.mode_var = tk.StringVar(value="off")
        
        for i, (label, val) in enumerate(modes):
            r = i // 3
            c = i % 3
            btn = tk.Radiobutton(mode_frame, text=label, value=val, variable=self.mode_var, 
                                 command=lambda v=val: self.set_mode(v), bg="#FFF0F5", activebackground="#FFF0F5")
            btn.grid(row=r, column=c, padx=10, pady=5, sticky="w")

        # ---- 档位选择区域 ----
        speed_frame = tk.LabelFrame(self.root, text=" 刻度 快慢档位 ", bg="#FFF0F5", fg="#DB7093", font=("Helvetica", 10))
        speed_frame.pack(fill="x", padx=20, pady=10)

        self.speed_var = tk.IntVar(value=0)
        for i in range(4):
            stars = "★" * i if i > 0 else "○"
            rb = tk.Radiobutton(speed_frame, text=f"{i}档 {stars}", value=i, variable=self.speed_var,
                                command=lambda s=i: self.set_speed(s), bg="#FFF0F5", activebackground="#FFF0F5")
            rb.grid(row=i//2, column=i%2, padx=20, pady=5, sticky="w")

        # ---- 状态锁定与百分比展示 ----
        control_frame = tk.Frame(self.root, bg="#FFF0F5")
        control_frame.pack(fill="x", padx=20, pady=5)

        self.lock_btn = tk.Button(control_frame, text="[-] 未锁定", command=self.toggle_lock, bg="#FFE4E1", fg="#CD5C5C", relief="groove")
        self.lock_btn.pack(side="left", padx=5)

        self.comfort_label = tk.Label(control_frame, text="[平静] 快感 0.0%", font=("Helvetica", 11, "bold"), bg="#FFF0F5", fg="#FF69B4")
        self.comfort_label.pack(side="right", padx=5)

        # 进度条
        self.progress = ttk.Progressbar(self.root, orient="horizontal", length=280, mode="determinate", style="TProgressbar")
        self.progress.pack(pady=15)

    def set_mode(self, mode):
        s = self.read_state()
        s["mode"] = mode
        self.write_state(s)

    def set_speed(self, speed):
        s = self.read_state()
        s["speed"] = speed
        self.write_state(s)

    def toggle_lock(self):
        s = self.read_state()
        s["locked"] = not s.get("locked", False)
        self.write_state(s)

    def tick(self):
        s = self.read_state()
        now = time.time()
        dt = now - s.get("lastTick", now)
        if dt > 5: dt = 1.0  

        if s["mode"] != "off" and s["speed"] > 0:
            s["comfort"] = min(100.0, s["comfort"] + s["speed"] * 1.5 * dt)
            s["active"] = True
        else:
            s["active"] = False
            if not s.get("locked", False):
                s["comfort"] = max(0.0, s["comfort"] - 2.0 * dt)

        s["comfort"] = round(s["comfort"], 1)
        s["lastTick"] = now
        self.write_state(s)
        self.root.after(1000, self.tick)

    def refresh_ui(self):
        s = self.read_state()
        self.mode_var.set(s.get("mode", "off"))
        self.speed_var.set(s.get("speed", 0))
        
        comfort = s.get("comfort", 0.0)
        self.progress["value"] = comfort

        # 将动态变动的高位 Emoji 同样替换为安全的文本标签
        tag = "[平静]"
        if comfort >= 20: tag = "[脸红]"
        if comfort >= 40: tag = "[微喘]"
        if comfort >= 70: tag = "[迷离]"
        if comfort >= 95: tag = "[失控]"
        self.comfort_label.config(text=f"{tag} 快感 {comfort}%")

        if s.get("locked", False):
            self.lock_btn.config(text="[+] 已锁定", bg="#FFB6C1", fg="#BA55D3")
        else:
            self.lock_btn.config(text="[-] 未锁定", bg="#FFE4E1", fg="#CD5C5C")

        self.root.after(500, self.refresh_ui)

if __name__ == "__main__":
    root = tk.Tk()
    app = VibeControllerApp(root)
    root.mainloop()