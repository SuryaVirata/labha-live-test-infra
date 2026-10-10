import socket, threading
JOBS = [(("127.0.0.1", 8080), ("172.17.0.1", 8080)),
        (("127.0.0.1", 5173), ("172.17.0.1", 5173))]
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except Exception:
        pass
    finally:
        try: a.close()
        except Exception: pass
        try: b.close()
        except Exception: pass
def serve(src, dst):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(src)
    srv.listen(50)
    print("forwarding", src, "->", dst, flush=True)
    while True:
        c, _ = srv.accept()
        try:
            u = socket.create_connection(dst, timeout=10)
        except Exception:
            c.close()
            continue
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()
for s, d in JOBS:
    threading.Thread(target=serve, args=(s, d), daemon=True).start()
import time
while True:
    time.sleep(3600)
