FROM python:3.8-slim-bullseye
RUN python -m pip install --no-cache-dir \
  pytest==6.2.5 pytest-cov==2.12.1 mock==4.0.3 hypothesis==6.56.4 \
  click==7.1.2 attrs==19.3.0 appdirs==1.4.3 toml==0.10.2 \
  typed-ast==1.4.3 regex==2020.11.13 pathspec==0.8.1 typing-extensions==3.7.4.3 mypy-extensions==0.4.3 \
  decorator==4.4.2 python_toolbox==0.9.3 \
  requests==2.25.1 requests-toolbelt==0.9.1 Pygments==2.7.4 \
  pydantic==1.7.4 starlette==0.12.9 python-multipart==0.0.5 email-validator==1.1.2 \
  aiofiles==0.6.0 websockets==8.1 uvloop==0.14.0 httptools==0.1.1 \
  multidict==4.7.6 ujson==4.0.2 \
  psutil==5.9.8 colorama==0.4.6 six==1.16.0 pyte==0.8.2
ENV PYTHONPATH=/workspace
WORKDIR /workspace
