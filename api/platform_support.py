"""Small OS adapters for private storage and launchers.

Windows chmod only changes the read-only flag. Use a protected NTFS DACL
instead, allowing the current Windows user and SYSTEM to access private data.
"""
from __future__ import annotations

import ctypes
import os
import socket
import sys
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def _windows_user_sid() -> str:
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                       ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                          ctypes.c_void_p, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p,
                                            ctypes.POINTER(wintypes.LPWSTR)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, buf, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.c_void_p.from_buffer(buf).value
        text = wintypes.LPWSTR()
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))
    finally:
        kernel.CloseHandle(token)


def _windows_private_acl(path: Path, directory: bool) -> None:
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.DWORD)]
    advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p,
        ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.BOOL)]
    advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int,
        wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p]
    advapi.SetNamedSecurityInfoW.restype = wintypes.DWORD
    kernel.LocalFree.argtypes = [ctypes.c_void_p]

    inheritance = "OICI" if directory else ""
    descriptor = f"D:P(A;{inheritance};FA;;;{_windows_user_sid()})(A;{inheritance};FA;;;SY)"
    security = ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor, 1, ctypes.byref(security), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        present, defaulted = wintypes.BOOL(), wintypes.BOOL()
        dacl = ctypes.c_void_p()
        if not advapi.GetSecurityDescriptorDacl(security, ctypes.byref(present),
                                                ctypes.byref(dacl), ctypes.byref(defaulted)):
            raise ctypes.WinError(ctypes.get_last_error())
        # SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION
        error = advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, dacl, None)
        if error:
            raise ctypes.WinError(error)
    finally:
        kernel.LocalFree(security)


def private_permissions(path: Path, mode: int = 0o600) -> None:
    """Fail closed when private file permissions cannot be established."""
    if sys.platform == "win32":
        _windows_private_acl(path, path.is_dir())
    else:
        os.chmod(path, mode)


@contextmanager
def process_file_lock(path: Path):
    """Exclusive lock shared by server processes; release on every exit path."""
    with open(path, "a+b") as fh:
        if sys.platform == "win32":
            import msvcrt

            # Windows byte-range locks need one byte. All processes lock byte 0.
            if fh.seek(0, os.SEEK_END) == 0:
                fh.write(b"\0")
                fh.flush()
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


def windows_listener_pids(port: int) -> set[int] | None:
    """Read IPv4/IPv6 listener ownership directly, including windowed builds.

    https://learn.microsoft.com/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable
    None means inspection failed; it must never be treated as an empty port.
    """
    if sys.platform != "win32":
        return None
    from ctypes import wintypes

    class Row4(ctypes.Structure):
        _fields_ = [(name, wintypes.DWORD) for name in
                    ("state", "local_addr", "local_port", "remote_addr", "remote_port", "pid")]

    class Row6(ctypes.Structure):
        _fields_ = [("local_addr", ctypes.c_ubyte * 16), ("local_scope", wintypes.DWORD),
                    ("local_port", wintypes.DWORD), ("remote_addr", ctypes.c_ubyte * 16),
                    ("remote_scope", wintypes.DWORD), ("remote_port", wintypes.DWORD),
                    ("state", wintypes.DWORD), ("pid", wintypes.DWORD)]

    try:
        helper = ctypes.WinDLL("iphlpapi", use_last_error=True)
        query = helper.GetExtendedTcpTable
        query.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL,
                          wintypes.ULONG, ctypes.c_int, wintypes.ULONG]
        query.restype = wintypes.DWORD
        owners = set()
        for family, row_type in ((2, Row4), (23, Row6)):
            size = wintypes.DWORD()
            error = query(None, ctypes.byref(size), False, family, 3, 0)  # OWNER_PID_LISTENER
            if error not in (0, 122) or not size.value:
                return None
            # The table may grow between the size query and the actual read.
            for _ in range(3):
                table = ctypes.create_string_buffer(size.value)
                error = query(table, ctypes.byref(size), False, family, 3, 0)
                if error != 122:
                    break
            if error:
                return None
            count = wintypes.DWORD.from_buffer(table).value
            offset = ctypes.sizeof(wintypes.DWORD)
            if offset + count * ctypes.sizeof(row_type) > len(table):
                return None
            for index in range(count):
                row = row_type.from_buffer(table, offset + index * ctypes.sizeof(row_type))
                if row.state == 2 and socket.ntohs(row.local_port & 0xffff) == port:
                    owners.add(row.pid)
        return owners
    except (OSError, AttributeError, ValueError):
        return None


def windows_process_details(pid: int) -> dict:
    """Query a process without spawning PowerShell or relying on console handles.

    NT information is dynamically resolved and bounds checked. When unavailable,
    callers retain their conservative CIM fallback; no ownership is inferred.
    https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess
    """
    if sys.platform != "win32" or not isinstance(pid, int) or pid <= 0:
        return {}
    from ctypes import wintypes

    class BasicInfo(ctypes.Structure):
        _fields_ = [("exit_status", wintypes.LONG), ("peb", ctypes.c_void_p),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.LONG),
                    ("pid", ctypes.c_size_t), ("parent_pid", ctypes.c_size_t)]

    class UnicodeString(ctypes.Structure):
        _fields_ = [("length", wintypes.USHORT), ("maximum", wintypes.USHORT),
                    ("buffer", ctypes.c_void_p)]

    handle = None
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
            wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        handle = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION only
        if not handle:
            return {}
        path = ctypes.create_unicode_buffer(32768)
        path_size = wintypes.DWORD(len(path))
        if not kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(path_size)):
            return {}
        details = {"executable": path.value}
        query = ctypes.WinDLL("ntdll").NtQueryInformationProcess
        query.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG,
                          ctypes.POINTER(wintypes.ULONG)]
        query.restype = wintypes.LONG
        basic = BasicInfo()
        if query(handle, 0, ctypes.byref(basic), ctypes.sizeof(basic), None) == 0:
            details["parent_pid"] = basic.parent_pid
        size = wintypes.ULONG()
        query(handle, 60, None, 0, ctypes.byref(size))  # CommandLineInformation, Windows 8.1+
        if not ctypes.sizeof(UnicodeString) <= size.value <= 1024 * 1024:
            return details
        command = ctypes.create_string_buffer(size.value)
        if query(handle, 60, command, len(command), ctypes.byref(size)) != 0:
            return details
        value = UnicodeString.from_buffer(command)
        start, end = ctypes.addressof(command), ctypes.addressof(command) + len(command)
        if (value.length % 2 or not value.buffer or value.buffer < start or
                value.buffer + value.length > end):
            return details
        details["command"] = ctypes.wstring_at(value.buffer, value.length // 2)
        return details
    except (OSError, AttributeError, ValueError):
        return {}
    finally:
        if handle:
            kernel.CloseHandle(handle)
