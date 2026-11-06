# 极简 CDP 客户端：手写 WebSocket 握手与帧编解码（不依赖第三方库）
# 用途：隔离实例上验证「组合器上传 → 素材节点 + 缩略图 + 连线」
import base64, hashlib, json, os, socket, struct, sys, time
import urllib.request

CDP = 'http://127.0.0.1:9222'
URL_ = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8781'
FILE = sys.argv[2] if len(sys.argv) > 2 else 'C:/Users/30543/WorkBuddy/2026-11-04-00-18-00/canvas/_probe/canvas/assets/_05____-e525e996.png'
OUT = 'C:/Users/30543/WorkBuddy/2026-11-04-00-18-00/canvas/projects/_uishot'


def http_json(url, method='GET'):
    req = urllib.request.Request(url, method=method)
    return json.load(urllib.request.urlopen(req, timeout=5))


class CDPClient:
    def __init__(self, ws_url):
        u = ws_url.replace('ws://', '')
        hostport, path = u.split('/', 1)
        path = '/' + path
        host, port = hostport.split(':') if ':' in hostport else (hostport, 80)
        self.sock = socket.create_connection((host, int(port)), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f'GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n'
            f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
            f'Sec-WebSocket-Version: 13\r\n\r\n'
        )
        self.sock.sendall(req.encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            resp += self.sock.recv(4096)
        assert b'101' in resp.split(b'\r\n')[0], resp[:200]
        self.buf = b''
        self.seq = 0
        self.pending = {}

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('ws closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_frame(self):
        b1, b2 = self._recv_exact(2)
        opcode = b1 & 0x0F
        ln = b2 & 0x7F
        if ln == 126:
            (ln,) = struct.unpack('>H', self._recv_exact(2))
        elif ln == 127:
            (ln,) = struct.unpack('>Q', self._recv_exact(8))
        payload = self._recv_exact(ln)
        return opcode, payload

    def send(self, method, params=None):
        self.seq += 1
        msg = json.dumps({'id': self.seq, 'method': method, 'params': params or {}})
        data = msg.encode()
        mask = os.urandom(4)
        hdr = b'\x81'
        n = len(data)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack('>Q', n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(hdr + mask + masked)
        return self.seq

    def wait(self, seq, timeout=30):
        t0 = time.time()
        while time.time() - t0 < timeout:
            for m in list(self.pending.values()):
                pass
            try:
                op, payload = self._read_frame()
            except socket.timeout:
                continue
            if op == 9:  # ping → pong
                self.sock.sendall(b'\x8a\x80' + os.urandom(0))
                continue
            if op == 8:
                raise ConnectionError('ws closed by peer')
            m = json.loads(payload.decode())
            if m.get('id') == seq:
                if 'error' in m:
                    raise RuntimeError(m['error'].get('message'))
                return m.get('result', {})
        raise TimeoutError(method if False else 'cdp timeout')

    def call(self, method, params=None, timeout=30):
        s = self.send(method, params)
        return self.wait(s, timeout)

    def ev(self, expr, timeout=30):
        r = self.call('Runtime.evaluate', {'expression': expr, 'returnByValue': True}, timeout)
        return r['result'].get('value')


tabs = [t for t in http_json(CDP + '/json/list') if t['type'] == 'page']
tab = next((t for t in tabs if URL_.split('//')[1].split('/')[0].split(':')[0] in t['url']), None)
if tab is None or '8781' not in tab['url']:
    tab = http_json(CDP + '/json/new?' + urllib.parse.quote(URL_ + '/?v=' + str(int(time.time() * 1000))), 'PUT')
    print('new tab', tab['id'])
    time.sleep(3)
else:
    print('reuse tab', tab['id'], tab['url'][:60])

c = CDPClient(tab['webSocketDebuggerUrl'])
c.call('Page.enable')
c.call('DOM.enable')
time.sleep(1)

info = c.ev('document.title + " | nodes=" + document.querySelectorAll(".node").length + " | gen=" + document.querySelectorAll(".node.gen").length')
print('page:', info)

# 用 Runtime 给 file input 塞文件不行，得走 DOM.setFileInputFiles —— 拿 nodeId
doc = c.call('DOM.getDocument', {'depth': -1})
q = c.call('DOM.querySelectorAll', {'nodeId': doc['root']['nodeId'], 'selector': '.node.gen input[type=file]'})
print('file inputs:', len(q['nodeIds']))
if not q['nodeIds']:
    sys.exit(1)
c.call('DOM.setFileInputFiles', {'files': [FILE], 'nodeId': q['nodeIds'][0]})
time.sleep(2.5)

state = c.ev('''(() => {
  const media = [...document.querySelectorAll('.node.media-node')]
  const edges = document.querySelectorAll('.react-flow__edge').length
  const wires = document.querySelectorAll('.wire-line').length
  const thumbs = [...document.querySelectorAll('.node.gen .gc-thumb')].map((t) => ({
    img: !!t.querySelector('img'),
    ph: !!t.querySelector('.gc-thumb-ph'),
  }))
  return { mediaCount: media.length,
           mediaSrc: media.map((m) => m.querySelector('img')?.getAttribute('src') || null),
           edges, wires, thumbs }
})()''')
print(json.dumps(state, ensure_ascii=False, indent=1))

clip = c.ev('''(() => {
  const els = [...document.querySelectorAll('.node')]
  if (!els.length) return null
  const xs = els.map((e) => e.getBoundingClientRect())
  const l = Math.min(...xs.map((r) => r.left)) - 60
  const t = Math.min(...xs.map((r) => r.top)) - 60
  const rr = Math.max(...xs.map((r) => r.right)) + 60
  const b = Math.max(...xs.map((r) => r.bottom)) + 60
  return { x: Math.max(0, Math.round(l)), y: Math.max(0, Math.round(t)), width: Math.round(rr - l), height: Math.round(b - t) }
})()''')
if clip:
    shot = c.call('Page.captureScreenshot', {'format': 'png', 'clip': {**clip, 'scale': 1.5}, 'captureBeyondViewport': True})
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, '60-upload-fix.png'), 'wb') as f:
        f.write(base64.b64decode(shot['data']))
    print('-> 60-upload-fix.png')
