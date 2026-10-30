//go:build windows

package processsupervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWindowsProviderLaunchIsHiddenWithoutChangingOwnership(t *testing.T) {
	command := exec.Command(os.Args[0])
	controller := &windowsController{}
	controller.Configure(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags != 0x08000000 {
		t.Fatalf("provider must be hidden without adding detach or breakaway flags: %+v", command.SysProcAttr)
	}
	controller.Configure(command)
	if command.SysProcAttr.CreationFlags != 0x08000000 {
		t.Fatal("repeated presentation configuration changed process ownership flags")
	}

	attributes := &syscall.SysProcAttr{CreationFlags: 0x00000200, NoInheritHandles: true, CmdLine: "existing command line"}
	command.SysProcAttr = attributes
	controller.Configure(command)
	if command.SysProcAttr != attributes || attributes.CreationFlags != 0x08000200 || !attributes.HideWindow || !attributes.NoInheritHandles || attributes.CmdLine != "existing command line" {
		t.Fatalf("unrelated process attributes must survive configuration: %+v", attributes)
	}
}

func TestWindowsProviderHasNoConsoleAndKeepsPipedIO(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsHiddenProviderHelper$")
	command.Env = append(os.Environ(), "HEAD_TEST_HIDDEN_PROVIDER=1")
	command.Stdin = strings.NewReader("selected synthetic input\n")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	(&windowsController{}).Configure(command)
	t.Logf("planned parent=%d command=%q cwd=%q ports=[]", os.Getpid(), command.Args, command.Dir)
	output, err := command.Output()
	if command.Process != nil {
		t.Logf("provider-exited pid=%d parent=%d", command.Process.Pid, os.Getpid())
	}
	if err != nil {
		t.Fatalf("hidden provider failed: %v output=%s", err, output)
	}
	var observed struct {
		ConsoleWindow uintptr `json:"consoleWindow"`
		PID           int     `json:"pid"`
		ParentPID     int     `json:"parentPid"`
		Input         string  `json:"input"`
	}
	if err := json.Unmarshal(output, &observed); err != nil {
		t.Fatal(err)
	}
	if observed.ConsoleWindow != 0 || observed.PID != command.Process.Pid || observed.ParentPID != os.Getpid() || observed.Input != "selected synthetic input\n" || stderr.String() != "hidden synthetic stderr\n" {
		t.Fatalf("hidden child must have no console and retain exact parent/pipe evidence: %+v", observed)
	}
	t.Logf("consoleWindow=%d exactPID=%d parent=%d stdin/stdout/stderr preserved", observed.ConsoleWindow, observed.PID, observed.ParentPID)
}

func TestWindowsHiddenProviderHelper(t *testing.T) {
	if os.Getenv("HEAD_TEST_HIDDEN_PROVIDER") != "1" {
		return
	}
	window, _, _ := kernel32.NewProc("GetConsoleWindow").Call()
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(2)
	}
	if _, err := os.Stderr.WriteString("hidden synthetic stderr\n"); err != nil {
		os.Exit(2)
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"consoleWindow": window, "pid": os.Getpid(), "parentPid": os.Getppid(), "input": string(input)}); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
