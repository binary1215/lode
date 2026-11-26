package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/worker"
)

var version = "0.0.0-dev"
var commit = "unknown"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version-json" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"commit":                commit,
			"version":               version,
			"workerProtocolVersion": worker.ProtocolVersion,
		})
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: lode-agent-worker [--version-json]")
		os.Exit(2)
	}
	if err := worker.Run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(2)
	}
}
