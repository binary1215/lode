package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/fileeffect"
	"github.com/binary1215/lode/native/lode-agent-worker/internal/processsupervisor"
)

var version = "0.0.0-dev"
var commit = "unknown"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version-json" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"commit":                         commit,
			"version":                        version,
			"supervisorProtocolVersion":      processsupervisor.ProtocolVersion,
			"interactiveProtocolVersion":     processsupervisor.InteractiveProtocolVersion,
			"jobProtocolVersion":             processsupervisor.JobProtocolVersion,
			"detachedJobOwnerSupported":      processsupervisor.DetachedJobOwnerSupported,
			"fileEffectProtocolVersion":      fileeffect.TransportProtocolVersion,
			"fileEffectSupported":            runtime.GOOS == "windows",
			"fileImageEffectProtocolVersion": fileeffect.ImageProtocolVersion,
			"fileImageEffectSupported":       runtime.GOOS == "windows",
		})
		return
	}
	if len(os.Args) != 1 {
		if len(os.Args) == 2 && os.Args[1] == "--interactive" {
			exitCode, err := processsupervisor.RunInteractive(os.Stdin, os.Stdout, os.Stderr)
			if err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
			}
			os.Exit(exitCode)
		}
		if len(os.Args) == 2 && os.Args[1] == "--file-effect" {
			os.Exit(fileeffect.RunTransport(os.Stdin, os.Stdout))
		}
		if len(os.Args) == 3 && os.Args[1] == "--job-state" {
			if err := processsupervisor.InspectJobOwner(os.Args[2]); err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(2)
			}
			return
		}
		if len(os.Args) == 3 && os.Args[1] == "--launch-job" {
			if err := processsupervisor.LaunchJob(os.Args[2]); err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(2)
			}
			return
		}
		if len(os.Args) == 3 && os.Args[1] == "--job" {
			exitCode, err := processsupervisor.RunJob(os.Args[2])
			if err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
			}
			os.Exit(exitCode)
		}
		fmt.Fprintln(os.Stderr, "usage: lode-agent-supervisor [--version-json | --interactive | --file-effect | --job <request> | --launch-job <request> | --job-state <request>]")
		os.Exit(2)
	}
	exitCode, err := processsupervisor.Run(os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
	}
	os.Exit(exitCode)
}
