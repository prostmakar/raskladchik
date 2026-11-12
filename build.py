#!/usr/bin/env python3
"""Сборка программы «Раскладчик» (трубы + лист + PDF).
Версия — в файле VERSION (1.1, 1.2, …), адрес обновлений — release.json {"repo": "владелец/репозиторий"}.

1. Склеивает src/app.template.html + src/*.js + vendor/pdfjs/* в одну страницу.
2. Кладёт страницу в launcher/app.html (её встраивает .exe) и dist/ (для открытия в браузере).
3. Собирает dist/Раскладчик.exe (нужен Go 1.24+; на Linux/macOS — кросс-компиляция).

Запуск:  python build.py            — страница + exe
         python build.py --no-exe   — только страница
"""
import base64, json, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC, VENDOR, LAUNCHER, DIST = (os.path.join(ROOT, d) for d in ('src', 'vendor/pdfjs', 'launcher', 'dist'))


def read(path, binary=False):
    with open(path, 'rb' if binary else 'r', **({} if binary else {'encoding': 'utf-8'})) as f:
        return f.read()


VERSION = read(os.path.join(ROOT, 'VERSION')).strip()
REPO = json.loads(read(os.path.join(ROOT, 'release.json'))).get('repo', '')
NAME = 'Раскладчик'


def release_notes():
    """notes/v*.md -> [{ver, text}] от новых к старым (встраивается в страницу: окно «Что нового»)"""
    out = []
    d = os.path.join(ROOT, 'notes')
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if f.startswith('v') and f.endswith('.md'):
            ver = f[1:-3]
            try:
                key = tuple(int(x) for x in ver.split('.'))
            except ValueError:
                continue
            out.append((key, ver, read(os.path.join(d, f)).strip()))
    out.sort(reverse=True)
    return json.dumps([{'ver': v, 'text': t} for _, v, t in out], ensure_ascii=False).replace('</', '<\\/')


def build_page():
    t = read(os.path.join(SRC, 'app.template.html')).replace('__APP_VER__', VERSION).replace('__APP_REPO__', REPO).replace('__APP_NOTES__', release_notes())
    parts = {
        '/*XTCUT*/': read(os.path.join(SRC, 'xtcut.js')),
        '/*MEDIA*/': read(os.path.join(SRC, 'media.js')),
        '/*CALC*/': read(os.path.join(SRC, 'calc.js')),
        '/*IGES*/': read(os.path.join(SRC, 'iges.js')),
        '/*STEP*/': read(os.path.join(SRC, 'step.js')),
        '/*VIEW3D*/': read(os.path.join(SRC, 'view3d.js')),
        '/*XLSX*/': read(os.path.join(SRC, 'xlsx.js')),
        '/*DXF*/': read(os.path.join(SRC, 'dxf.js')),
        '/*DXFCLEAN*/': read(os.path.join(SRC, 'dxfclean.js')),
        '/*NEST2D*/': read(os.path.join(SRC, 'nest2d.js')),
        '/*SHEETUI*/': read(os.path.join(SRC, 'sheetui.js')),
        '/*DXFEDIT*/': read(os.path.join(SRC, 'dxfedit.js')),
        '/*TUBECUT*/': read(os.path.join(SRC, 'tubecut.js')),
        '/*PDFEDIT*/': read(os.path.join(SRC, 'pdfedit.js')),
        '/*JBIG2*/': base64.b64encode(read(os.path.join(VENDOR, 'jbig2.wasm'), True)).decode(),
        '/*PDFWK*/': read(os.path.join(VENDOR, 'pdf.worker.min.mjs')),
        '/*PDFJS*/': read(os.path.join(VENDOR, 'pdf.min.mjs')),
    }
    for key, value in parts.items():  # порядок важен: большие библиотеки вставляются последними
        if '</script' in value.lower():
            sys.exit(f'{key}: в коде встречается </script — страница сломается')
        if t.count(key) != 1:
            sys.exit(f'{key}: метка должна встречаться в шаблоне ровно один раз')
        i = t.index(key)
        t = t[:i] + value + t[i + len(key):]
    return t


def main():
    page = build_page()
    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(LAUNCHER, 'app.html'), 'w', encoding='utf-8') as f:
        f.write(page)  # метку /*STARTUP*/ заменяет сам .exe при запуске
    with open(os.path.join(DIST, NAME + '.html'), 'w', encoding='utf-8') as f:
        f.write(page.replace('/*STARTUP*/', '', 1))
    print(f'страница: {len(page) // 1024} КБ')

    if '--no-exe' in sys.argv:
        return
    if not shutil.which('go'):
        sys.exit('Go не найден — установите Go 1.24+ (https://go.dev/dl/) или запустите с --no-exe')
    env = dict(os.environ, GOOS='windows', GOARCH='amd64', CGO_ENABLED='0')
    exe = os.path.join(DIST, NAME + '.exe')
    subprocess.run(['go', 'build', '-trimpath', '-ldflags', f'-H windowsgui -s -w -X main.version={VERSION} -X main.repo={REPO}', '-o', exe, '.'],
                   cwd=LAUNCHER, env=env, check=True)
    print(f'exe: {os.path.getsize(exe) // 1024} КБ -> {exe}')


if __name__ == '__main__':
    main()
