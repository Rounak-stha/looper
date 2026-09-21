FROM python:3.8-slim-bullseye
RUN python -m pip install --no-cache-dir \
    click==7.1.2 attrs==19.3.0 appdirs==1.4.3 toml==0.10.0 \
    typed-ast==1.4.3 regex==2020.2.20 pathspec==0.8.0 typing-extensions==3.7.4.2 mypy-extensions==0.4.3 \
    aiohttp==3.6.2 aiohttp-cors==0.7.0 async-timeout==3.0.1 chardet==3.0.4 idna==2.9 multidict==4.7.5 yarl==1.4.2
RUN printf '%s\n' '#!/bin/sh' 'test -e /workspace/_black_version.py || echo '\''version = "bugsinpy"'\'' > /workspace/_black_version.py' 'exec "$@"' > /usr/local/bin/bugsinpy-black-test && chmod 755 /usr/local/bin/bugsinpy-black-test
ENV PYTHONPATH=/workspace
WORKDIR /workspace
