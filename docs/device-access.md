# 受控设备访问

设备能力需先写入 manifest 并获批。开始采集、读取定位或选择外设时，用户还需确认操作，并完成浏览器自己的许可或选择流程。接口只返回本次运行的句柄、数据快照或字节；句柄不能跨应用、跨运行复用。

| 权限               | 可用能力                                           |
| ------------------ | -------------------------------------------------- |
| `camera`           | 摄像头预览、截图、录像                             |
| `microphone`       | 麦克风录音；摄像头录像附带麦克风时也需批准         |
| `screen.capture`   | 用户选择的屏幕、窗口或标签页；音频由屏幕选择器决定 |
| `location.read`    | 用户允许的一次定位                                 |
| `device.usb`       | 用户选中的、符合审核清单的 USB 设备                |
| `device.bluetooth` | 用户选中的蓝牙设备及审核过的服务、特征操作         |

需要安全页面及浏览器支持。不支持的 API 返回 `BROWSER_UNSUPPORTED`，用户拒绝或关闭选择器返回 `USER_CANCELLED`。应用不能指定任意设备 UUID、扩大选择过滤器或自动取得另一应用选过的设备。

## 摄像头、录音与屏幕

`media.capture` 使用以下字段：

| 字段               | 含义                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `kind`             | `camera`、`microphone` 或 `screen`                                                           |
| `record`           | 是否录制；麦克风默认开启，摄像头和屏幕默认关闭                                               |
| `audio`            | 摄像头附带麦克风，或请求屏幕选择器提供共享音频；默认关闭                                     |
| `mime`             | 可选录制格式；须由当前浏览器的 MediaRecorder 支持                                            |
| `chunkMs`          | 可选分块间隔，默认 1000 毫秒；不限制总录制时长                                               |
| `videoConstraints` | 可选 `width`、`height`、`frameRate`、`facingMode`                                            |
| `audioConstraints` | 可选 `sampleRate`、`channelCount`、`echoCancellation`、`noiseSuppression`、`autoGainControl` |

摄像头的 `audio: true` 同时需要 `camera` 和 `microphone`。屏幕的 `audio: true` 使用浏览器共享选择器提供的声音，不会另开麦克风；用户未选择共享声音时，可能只有视频轨道。预览始终静音。

SDK 调用为 `media.capture(kind, options)`。数值约束可用基本数值或含 `ideal`、`exact`、`min`、`max` 的对象；布尔约束只接受布尔值或 `ideal`/`exact`。`facingMode` 只接受 `user`、`environment`、`left`、`right`，不用于屏幕采集。不接受 `deviceId`、`groupId`、`advanced` 或未知字段。屏幕约束在用户选择共享对象后应用，不能代替用户选择。

开始后返回 `{ handle, kind, mime, tracks }`，其中 `tracks` 仅包含轨道的 `kind`、`label`、`enabled`。未录制时 `mime` 为 `null`。

- `media.nextFrame`：传 `handle`，可选 `mime` 为 `image/png`、`image/jpeg` 或 `image/webp`，`quality` 为 0–1。返回 `{ bytes, mime, width, height }`。实际 MIME 以结果为准。
- `media.readRecording`：传录制句柄，按顺序取得 `{ bytes, mime, seq }`。没有下一块时等待，可取消。
- `media.finishRecording`：停止录制，返回 `{ mime, chunks }`，包含尚未读取的所有块和停止时的尾块，随后释放句柄。
- `media.readAudio`、`media.finishAudio`：上述录制方法的麦克风专用别名。
- `media.stop`：立即取消采集并丢弃未读取的块。适用于取消、关闭和卸载；需要保存完整录制时使用 `finishRecording`。

连续块不一定能分别播放。保存或上传时须按 `seq` 顺序保留容器首部、中间块及尾块；不要只取最新块。分块时刻由浏览器调度，不能据此精确计算录制时长。[MediaStream Recording 规范](https://www.w3.org/TR/mediastream-recording/)

浏览器撤销采集、设备断开、调用取消或应用关闭后，句柄会失效。停止后不能继续截取新画面。

## 定位

`location.get` 可传 `highAccuracy` 和 `maximumAge`，返回 `latitude`、`longitude`、`accuracy`、`altitude`、`altitudeAccuracy`、`heading`、`speed`、`timestamp` 的数据快照。可选坐标信息可能为 `null`。这是一条定位请求，不持续追踪用户；取消会清理本次定位监听。

## USB 审核清单

```json
{
  "permissions": ["device.usb"],
  "devices": {
    "usb": {
      "board": {
        "filters": [{ "vendorId": 9025, "productId": 1 }],
        "controlTransfers": {
          "setMode": {
            "direction": "out",
            "requestType": "vendor",
            "recipient": "device",
            "request": 1,
            "value": 2,
            "index": 0
          }
        }
      }
    }
  }
}
```

替换为自己的设备协议。过滤器必须指定 `vendorId`；可补充 `productId`、`classCode`、`subclassCode`、`protocolCode`、`serialNumber`。子类需同时指定类，协议需同时指定子类。控制传输按别名声明完整的方向、请求类型、接收对象、请求码、value 和 index，调用时不能更改这些字段。

`usb.request` 选择声明的设备后返回句柄、厂商/产品信息以及配置、接口、备用设置和端点的数据快照。按设备协议先 `selectConfiguration`，再 `claimInterface`，随后读写：

| 方法                           | 字段与结果                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `usb.request`                  | `device` 为清单别名；打开用户选择的设备                                                                             |
| `usb.selectConfiguration`      | `handle`、`configuration`                                                                                           |
| `usb.claimInterface`           | `handle`、`interface`，可选 `alternate`                                                                             |
| `usb.releaseInterface`         | `handle`、`interface`                                                                                               |
| `usb.selectAlternateInterface` | `handle`、已申请的 `interface`、该接口存在的 `alternate`                                                            |
| `usb.read`                     | `handle`、输入方向 `endpoint`、`length`；返回 `{ status, bytes }`                                                   |
| `usb.write`                    | `handle`、输出方向 `endpoint`、`data`；返回 `{ status, bytesWritten }`                                              |
| `usb.isochronousRead`          | `handle`、等时输入 `endpoint`、`packetLengths`；返回按序的 `{ packets: [{ status, bytes }] }`                       |
| `usb.isochronousWrite`         | `handle`、等时输出 `endpoint`、`packetLengths`、总长度匹配的 `data`；返回 `{ packets: [{ status, bytesWritten }] }` |
| `usb.clearHalt`                | `handle`、`direction`、已声明于当前接口的 `endpoint`                                                                |
| `usb.controlTransferIn`        | `handle`、审核清单中的 `transfer` 别名、`length`                                                                    |
| `usb.controlTransferOut`       | `handle`、`transfer` 别名、`data`                                                                                   |
| `usb.close`                    | `handle`；释放当前连接                                                                                              |

端点须属于当前已申请的接口，输入和输出方向不可混用。控制传输受 USB 协议的 16 位长度字段约束。取消正在进行的原生传输会关闭该连接；已经写入外设的数据无法撤回。接口不会自动重放写入。[WebUSB 使用说明](https://developer.chrome.com/docs/capabilities/usb)

## 蓝牙审核清单

```json
{
  "permissions": ["device.bluetooth"],
  "devices": {
    "bluetooth": {
      "sensor": {
        "filters": [{ "namePrefix": "Sensor" }],
        "services": {
          "battery": {
            "uuid": "0000180f-0000-1000-8000-00805f9b34fb",
            "characteristics": {
              "level": {
                "uuid": "00002a19-0000-1000-8000-00805f9b34fb",
                "read": true,
                "notify": true
              }
            }
          }
        }
      }
    }
  }
}
```

过滤器至少含非空 `name`、`namePrefix` 或 `services`；筛选服务必须出现在审核清单中。服务和特征使用小写完整 128 位 UUID。每个特征明确批准 `read`、`write`、`notify` 中需要的操作，调用只传别名。

- `bluetooth.request`：选择 `device` 别名，返回 `{ handle, name, connected }`；随后调用 `bluetooth.connect`。
- `bluetooth.read`、`bluetooth.write`：传 `handle`、`service`、`characteristic`；写入另传 `data`，可选 `withoutResponse`。读取返回 `{ bytes }`。
- `bluetooth.startNotifications`：同样指定服务和特征，返回 `{ subscription }`。
- `bluetooth.nextNotification`：传 `subscription`，按顺序取得 `{ bytes, seq }`，没有数据时等待。不会合并或静默丢弃尚未消费的通知。
- `bluetooth.stopNotifications`：停止订阅并清理监听。
- `bluetooth.close`：释放当前连接及其所有订阅。

通知沿用浏览器的 `characteristicvaluechanged` 事件语义，读取特征值也可能触发该事件。设备断开或连接被取消后，重新选择设备并取得新的句柄；不复用旧服务/特征对象。[Web Bluetooth 使用说明](https://developer.chrome.com/docs/capabilities/bluetooth)

以上清单定义允许调用的设备协议，不保证具体外设、驱动或浏览器已实现该协议。真实硬件兼容需由开发者使用自己的设备验证。
