import os
from app.main import app, start_worker, DEBUG

if __name__ == '__main__':
    # Local development server. Debug only with WAUDIBLE_DEBUG=1.
    # With debug on, the reloader runs this file twice. Only the child
    # process (WERKZEUG_RUN_MAIN) serves requests, so only it starts the worker.
    if not DEBUG or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_worker(app)
    app.run(debug=DEBUG, port=5000)
