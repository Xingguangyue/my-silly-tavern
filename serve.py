# -*- coding: utf-8 -*-
"""
本地开发服务器 —— 同时做两件事：

  1. 提供静态文件（index.html / style.css / app.js），这样不必用 file:// 打开
  2. 把 POST /api/chat 转发到真正的模型 API

为什么要转发？
  浏览器出于安全策略，会拦截「页面」去读取另一个域名返回的内容（跨域 / CORS）。
  如果模型服务没有明确允许你的页面访问，浏览器就会把响应丢掉 —— 你只会看到
  一条 fetch 报错，而服务端其实一切正常。
  改成「浏览器 → 本地 serve.py → 模型服务」之后：页面和 serve.py 同源，不存在
  跨域；真正那次跨域请求是 Python 发出去的，Python 不受 CORS 限制。

用法：
  E:\\Python312\\python.exe serve.py
  然后浏览器打开 http://localhost:8000
  在右边「设置」里勾上「通过本地代理转发」

只监听 127.0.0.1，不对外开放。
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8000"))
TIMEOUT = 180          # 秒。模型想得久一点也不会被掐断


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        # directory=ROOT：静态文件固定从这个脚本所在的目录取
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] " + (fmt % args) + "\n")

    # ---------------- 健康检查 ----------------
    def do_GET(self):
        if self.path == "/api/ping":
            self._json(200, {"ok": True, "root": ROOT})
            return
        super().do_GET()          # 其余交给静态文件处理

    # ---------------- 转发聊天请求 ----------------
    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404, "只支持 POST /api/chat")
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)

        upstream = (self.headers.get("X-Upstream-Base") or "").rstrip("/")
        if not upstream:
            self._json(400, {"error": "缺少 X-Upstream-Base 请求头"})
            return

        target = upstream + "/chat/completions"
        req = urllib.request.Request(target, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        auth = self.headers.get("Authorization")
        if auth:
            req.add_header("Authorization", auth)

        try:
            resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            self._json(e.code, {"error": "上游返回 HTTP %d" % e.code,
                                "detail": detail[:2000]})
            return
        except Exception as e:
            self._json(502, {"error": "连不上模型服务：" + str(e)})
            return

        # 逐块转发 —— 这样前端的流式输出才能真的"边生成边显示"
        try:
            self.send_response(resp.status)
            self.send_header("Content-Type",
                             resp.headers.get("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = resp.read(256)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass          # 用户点了「中止」，连接断开是正常现象
        finally:
            resp.close()

    def _json(self, code, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    os.chdir(ROOT)
    print("=" * 56)
    print("我的酒馆 · 本地服务已启动")
    print("  打开： http://localhost:%d" % PORT)
    print("  记得在右边「设置」里勾上「通过本地代理转发」")
    print("  停止： Ctrl + C")
    print("=" * 56)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
