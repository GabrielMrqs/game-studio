// Fixture only: intercepts exec syscalls, not process containment or run ownership.
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

static int send_fd(int socket, int fd) {
    char byte = 'L';
    struct iovec io = { .iov_base = &byte, .iov_len = 1 };
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &fd, sizeof(fd));
    return sendmsg(socket, &message, 0) == 1 ? 0 : -1;
}

static int recv_fd(int socket) {
    char byte;
    struct iovec io = { .iov_base = &byte, .iov_len = 1 };
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
    if (recvmsg(socket, &message, MSG_CMSG_CLOEXEC) != 1) return -1;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (!header || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS || header->cmsg_len != CMSG_LEN(sizeof(int))) return -1;
    int fd;
    memcpy(&fd, CMSG_DATA(header), sizeof(fd));
    return fd;
}

static int install_gate(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execve, 1, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execveat, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    return syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int verify_binding(const char *helper, const char *context, pid_t root, const struct seccomp_notif *pending, size_t count, char *namespace, size_t size) {
    char pid[32];
    snprintf(pid, sizeof(pid), "%ld", (long)root);
    int output[2];
    if (pipe(output) != 0) return 0;
    pid_t verifier = fork();
    if (verifier < 0) { close(output[0]); close(output[1]); return 0; }
    if (verifier == 0) {
        close(3);
        close(output[0]);
        if (dup2(output[1], STDOUT_FILENO) < 0) _exit(2);
        close(output[1]);
        char numbers[256][32];
        char *arguments[261] = { "/usr/bin/node", (char *)helper, (char *)context, pid };
        for (size_t i = 0; i < count; i++) {
            snprintf(numbers[i], sizeof(numbers[i]), "%u", pending[i].pid);
            arguments[4 + i] = numbers[i];
        }
        execv(arguments[0], arguments);
        _exit(127);
    }
    close(output[1]);
    size_t used = 0;
    ssize_t got;
    while (used < size - 1 && (got = read(output[0], namespace + used, size - used - 1)) > 0) used += (size_t)got;
    close(output[0]);
    namespace[used] = '\0';
    int status;
    while (waitpid(verifier, &status, 0) < 0) {
        if (errno != EINTR) return 0;
    }
    return WIFEXITED(status) && WEXITSTATUS(status) == 0 && used > 0;
}

static int same_namespace(pid_t pid, const char *expected) {
    char file[64], actual[64];
    snprintf(file, sizeof(file), "/proc/%ld/ns/pid", (long)pid);
    ssize_t length = readlink(file, actual, sizeof(actual) - 1);
    if (length < 0) return 0;
    actual[length] = '\0';
    return strcmp(actual, expected) == 0;
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *helper = NULL, *context = NULL;
    int command_at = 1;
    if (strcmp(argv[1], "--verify") == 0) {
        if (argc < 6 || strcmp(argv[4], "--") != 0) return 2;
        helper = argv[2];
        context = argv[3];
        command_at = 5;
    }
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) != 0) return 2;
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) {
        close(sockets[0]);
        close(3);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() == 1) _exit(2);
        int listener = install_gate();
        if (listener < 0 || send_fd(sockets[1], listener) != 0) _exit(2);
        close(listener);
        close(sockets[1]);
        execvp(argv[command_at], argv + command_at);
        _exit(127);
    }
    close(sockets[1]);
    int listener = recv_fd(sockets[0]);
    close(sockets[0]);
    if (listener < 0) { kill(child, SIGKILL); waitpid(child, NULL, 0); return 2; }
    signal(SIGPIPE, SIG_IGN);
    int open = 1, allow_git = 0, allow_bash = 0, status;
    char allowed_namespace[64] = {0};
    struct seccomp_notif pending[256] = {0};
    int pending_kind[256] = {0};
    size_t pending_count = 0;
    for (;;) {
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        if (result < 0 && errno != EINTR) break;
        struct pollfd fds[] = { { .fd = 3, .events = POLLIN }, { .fd = listener, .events = POLLIN } };
        int ready = poll(fds, 2, 100);
        if (ready < 0) { if (errno == EINTR) continue; break; }
        if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) break;
        if (fds[0].revents & POLLIN) {
            char command;
            if (read(3, &command, 1) != 1 || (command != 'H' && command != 'R' && command != 'G' && command != 'B')) break;
            if (command == 'R' && open) break;
            if (helper && ((command == 'R' && !verify_binding(helper, context, child, pending, pending_count, allowed_namespace, sizeof(allowed_namespace))) || command == 'G' || command == 'B')) {
                if (write(3, "E", 1) != 1) break;
                continue;
            }
            open = command == 'R';
            allow_git = command == 'G' || command == 'B';
            allow_bash = command == 'B';
            if (write(3, &command, 1) != 1) break;
            if (open || allow_git || allow_bash) {
                size_t kept = 0;
                for (size_t i = 0; i < pending_count; i++) {
                    if (open || (allow_git && pending_kind[i] == 1) || (allow_bash && pending_kind[i] == 2)) {
                        struct seccomp_notif_resp response = { .id = pending[i].id, .flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE };
                        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0 && errno != ENOENT) goto done;
                    } else {
                        pending[kept] = pending[i];
                        pending_kind[kept++] = pending_kind[i];
                    }
                }
                pending_count = kept;
            }
        }
        if (fds[1].revents & POLLIN) {
            struct seccomp_notif request = {0};
            struct seccomp_notif_resp response = {0};
            if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request) != 0) {
                if (errno == EINTR || errno == ENOENT) continue;
                break;
            }
            char path[4096] = {0};
            struct iovec local = { .iov_base = path, .iov_len = sizeof(path) - 1 };
            struct iovec remote = { .iov_base = (void *)(uintptr_t)request.data.args[request.data.nr == __NR_execveat ? 1 : 0], .iov_len = sizeof(path) - 1 };
            int readable = process_vm_readv(request.pid, &local, 1, &remote, 1, 0) >= 0;
            int is_git = readable && (strcmp(path, "/usr/bin/git") == 0 || strcmp(path, "/usr/lib/git-core/git") == 0);
            int is_bash = readable && strcmp(path, "/usr/bin/bash") == 0;
            if (open && helper && allowed_namespace[0] && !same_namespace(request.pid, allowed_namespace)) {
                response.id = request.id;
                response.error = -EPERM;
                if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0 && errno != ENOENT) break;
            } else if (open || (allow_git && is_git) || (allow_bash && is_bash)) {
                response.id = request.id;
                response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
                if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0 && errno != ENOENT) break;
            } else {
                if (pending_count == sizeof(pending) / sizeof(pending[0])) break;
                pending[pending_count] = request;
                pending_kind[pending_count++] = is_git ? 1 : is_bash ? 2 : 0;
                if (!readable)
                    fprintf(stderr, "held exec: unreadable pathname (errno %d)\n", errno);
                else
                    fprintf(stderr, "held exec: %s\n", path);
            }
        }
    }
done:
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    return 2;
}
