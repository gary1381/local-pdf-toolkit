# Static server for the PDFCraft harness page: python3 serve.py DIR PORT (correct types for .mjs).
import functools, http.server, sys
H = http.server.SimpleHTTPRequestHandler
H.extensions_map.update({".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"})
H.log_message = lambda *a: None
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), functools.partial(H, directory=sys.argv[1])).serve_forever()
