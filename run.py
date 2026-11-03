import os
from app.main import app, start_worker

if __name__ == '__main__':
    # The debug reloader runs this file twice. Only the child process
    # (WERKZEUG_RUN_MAIN) serves requests, so only it starts the worker.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_worker(app)
    app.run(debug=True, port=5000)
