# -*- coding: utf-8 -*-
"""确认提交：消息编码、文件数、以及没有多余文件。

用法：python tools/verify-commit.py
"""
import os
import subprocess

# 仓库根 = 本文件所在 tools/ 的上级。不要写死绝对路径 ——
# 仓库是给别人读的，机器专属路径不该出现。
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(*a):
    p = subprocess.run(['git'] + list(a), cwd=R, capture_output=True)
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


rc, out, _ = git('log', '-1', '--pretty=format:%H%n%s%n%b')
print('=== 提交消息 ===')
print(out)
print('\nU+FFFD 出现次数:', out.count('\ufffd'), '(0 = 干净)')

rc, out, _ = git('show', '--stat', '--oneline', 'HEAD')
print('\n=== 文件级 ===')
print(out.strip().split('\n')[-1])

rc, out, _ = git('status', '--short')
print('工作区:', '干净' if not out.strip() else '有未提交改动:\n' + out)

rc, out, _ = git('rev-list', '--count', 'HEAD')
print('提交数:', out.strip())

rc, out, _ = git('remote', '-v')
print('远程:', out.strip() or '（没有 remote —— 未 push）')
