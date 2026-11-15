# MAIN-01 스테이션 주 화면

## 이 화면이 무엇인가

| 항목 | 내용 |
|---|---|
| ID | MAIN-01 |
| 이름 | 스테이션 주 화면 |
| IA 묶음 | MAIN |
| 그리는 코드 | `station/ui/main_window.py#MainWindow` |
| 추정 | 코드만 보고 쓴 추정 |

## 개요

스테이션을 켜면 처음 보는 화면이다.

## 화면 흐름

상태를 보고, 저장하고, 자세히 보기를 켠다.

## 화면요소

| ID | 한 줄 | 위치 | 조작하면 실행되는 기능 | 보여 주는 기능 |
|---|---|---|---|---|
| MAIN-01#1 | 저장 버튼 | `station/ui/main_window.py:18` | `fe/station/ui/main_window/MainWindow@clicked:_save` | |
| MAIN-01#2 | 초기화 버튼 | `station/ui/main_window.py:20` | `fe/station/ui/main_window/MainWindow@clicked:reset_button` | |
| MAIN-01#3 | 자세히 보기 체크 | `station/ui/main_window.py:22` | `fe/station/ui/main_window/MainWindow@toggled:_toggle_details` | |
| MAIN-01#4 | 상태 줄 | `station/ui/main_window.py:24` | | `fe/station/ui/main_window/MainWindow@effect:_poll` |
| MAIN-01#5 | 내보내기 버튼 | `station/ui/main_window.py:30` | `fe/station/ui/main_window/MainWindow@clicked:_export` | |

## 화면 정책

| 정책 | 조건 | 주체 | 행위 |
|---|---|---|---|
| P1 | 상태를 읽지 못했다 | 스테이션 주 화면 | 이전 값을 지운다 |
| P2 | 저장 중이다 | 스테이션 주 화면 | 저장 버튼을 막는다 |
